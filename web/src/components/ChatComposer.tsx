import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, FileText, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExpandableImage } from "@/components/ExpandableImage";
import { Shortcut } from "@/components/ui/kbd";
import { usePrRefs } from "@/store";
import { NO_WALK, appendQuote, filterPrRefs, historyKey, historyStep, insertPrRef, prRefLabel, prTrigger, type HistoryWalk, type PrRef } from "@/workstream";
import { cn, PipContext } from "@/lib/utils";
import { clearDraft, draftFiles, loadDraft, saveDraft } from "@/lib/composerDraft";
import { joinPrefill } from "@/lib/palette";
import { endTypeahead } from "@/lib/orchestratorOpen";
import type { OrchestratorPrefill } from "@/lib/atoms";
import { enterSends, isCoarse, isMobile, keepComposerFocus } from "@/lib/viewport";

// The one chat input, shared by the new-draft box, the follow-up box and the quick-ask box. A single bordered
// "chatbox" (à la Claude/ChatGPT) wrapping image thumbnails, the textarea, and a bottom toolbar
// with the repo selector (via `leading`) on the left and an icon send button on the right.
// Accepts files of any type by paste, drag-drop, or the paperclip picker; Enter sends; Shift/⌘/Ctrl+Enter breaks the line.
// On a touch screen Enter breaks the line (a phone keyboard has no Shift+Enter) and the button sends.
// Owns its own text + attachments; with a `persistKey` it survives page reloads (localStorage).
// `variant="quick"` is the same input dressed as the quick-ask box (components/QuickAsk): no border of
// its own (the host's morphing surface is the box), an `icon` top left beside a three-line textarea,
// and a labelled Send with its keycap; its @ picker is portaled out of the host's overflow-hidden.
export function ChatComposer({
  persistKey, onSubmit, placeholder, leading, footer, onCancel, autoFocus, optimistic, history, action, alt, className, repo, prefill, insert,
  variant = "box", icon, inputLabel,
}: {
  variant?: "box" | "quick";
  icon?: ReactNode; // quick variant: sits top left, the text the whole width beside it
  inputLabel?: string; // the textarea's aria-label

  // Text asked for from outside the box (the orchestrator's top-bar entry, O, the palette): it goes
  // after the draft and the box takes focus. Every new `seq` is applied; one `session`'s asks replace
  // each other (keystrokes typed in the entry before this box mounted).
  prefill?: OrchestratorPrefill | null;
  // A one-shot insertion from outside the box (a message's Quote button): appended after whatever
  // draft is already there — never replacing it — then the box is focused with the caret at the
  // end. Unlike `prefill`, there is no "session" to group repeats: every `seq` is its own append.
  insert?: { text: string; seq: number } | null;
  // The repo this conversation is about (a workstream's, the new-draft box's selection). The @ PR
  // picker inserts a bare `#123` for that repo's PRs and `repo#123` for any other's.
  repo?: string;
  className?: string; // extra classes for the box itself, e.g. a host's own background
  persistKey?: string; // if set, text + images persist to localStorage under this key
  onSubmit: (text: string, images: File[]) => Promise<void>;
  placeholder?: string;
  leading?: ReactNode; // e.g. the repo selector, sits bottom-left inside the box
  footer?: ReactNode; // transient line below the box, e.g. a "Sent · Undo" affordance
  // Replaces the attach button beside send (the new-draft box gives that slot to "New chat" so the
  // repo/provider dropdowns keep their width). Paste and drag-drop still attach files.
  action?: ReactNode;
  // A second way to send the same text, shown as a button beside Send — e.g. the chat's
  // "stop & send" while a run is in flight. Same clearing/error handling as Send.
  alt?: { label: string; title?: string; onSubmit: (text: string, images: File[]) => Promise<void> };
  onCancel?: () => void;
  autoFocus?: boolean;
  // Fire-and-forget: hand the message to onSubmit and return at once (no spinner, no clearing).
  // The parent closes the box immediately and owns the outcome — it keeps the persisted draft so a
  // failure can reopen with the same text, and clears it on success. Used by the follow-up box.
  optimistic?: boolean;
  // Messages you sent in this chat, NEWEST first (workstream `composerHistory`), recalled with ↑/↓
  // like a terminal: ↑ on the first line, ↓ on the last; ↓ past the newest gives the draft back.
  history?: string[];
}) {
  // Popped out into the orchestrator's Picture-in-Picture window: `max-md:` utilities below would
  // read THAT window's own (often narrow) width rather than the main one, so this skips them there.
  const pip = useContext(PipContext);
  const [value, setText] = useState(() => (persistKey ? loadDraft(persistKey).text : ""));
  // What the box holds as of the last edit, committed or not: a send that fails fast can land before
  // React has rendered the clear, so the textarea's DOM value would still read as the sent text.
  const latest = useRef(value);
  const setValue = (v: string) => { latest.current = v; setText(v); };
  const walk = useRef<HistoryWalk>(NO_WALK); // where a ↑/↓ walk through `history` stands, and the draft it left
  const [images, setImages] = useState<File[]>([]);
  const [hydrated, setHydrated] = useState(!persistKey);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // @ PR picker: the `@query` at the caret lists the board's cached PRs (open first). Escape
  // dismisses it for THAT `@` (until a new one is typed); a pick replaces the query with the ref.
  const { refs, repoCount } = usePrRefs();
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  // Whether the queued caret set below should also focus the box — true for a pick or a Quote (the
  // user's own click), false for a prefill on mobile (see below): opening the orchestrator with text
  // already in hand must not pop the on-screen keyboard over the page.
  const pendingFocus = useRef(true);
  const listId = useId();
  const trig = prTrigger(value, caret);
  const matches = trig && trig.start !== dismissedAt ? filterPrRefs(refs, trig.query) : [];
  const picking = matches.length > 0;
  const activeIdx = Math.min(active, Math.max(0, matches.length - 1));
  const optionId = (i: number) => `${listId}-pr-${i}`;
  const pick = (ref: PrRef) => {
    if (!trig) return;
    const next = insertPrRef(value, trig.start, caret, prRefLabel(ref, refs, repoCount, repo));
    pendingCaret.current = next.caret;
    pendingFocus.current = true; // the box already has focus (that's how the picker opened) — a no-op either way
    setDismissedAt(trig.start); // a pick is done with that `@`, even if the text still parses as one
    setValue(next.text);
    setCaret(next.caret);
  };
  // Put the caret after an inserted ref once React has written the new value.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && pendingCaret.current !== null) {
      if (pendingFocus.current) el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);
  const quick = variant === "quick";
  const rootRef = useRef<HTMLDivElement>(null);
  // Quick variant: grow with the text where `field-sizing: content` isn't supported (Safari, Firefox),
  // where the box stayed one scrolling line. The CSS min / max heights still bound it.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!quick || !el || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [quick, value]);
  const prefillBase = useRef<{ session: number; base: string } | null>(null);
  // A LAYOUT effect, so the box has focus in the same commit that opened it — before the browser
  // paints, and so before the next keystroke. (A passive effect focused it a frame late: the first
  // letter went elsewhere or, focused mid-word, "Sometimes" came out "ometimesS".) Keys typed before
  // even that (lib/orchestratorOpen's typeahead) are appended in order. A box that already has focus
  // keeps its caret and value: whatever the user has typed is never moved or reset.
  useLayoutEffect(() => {
    if (!prefill) return;
    const fresh = prefillBase.current?.session !== prefill.session;
    if (fresh) prefillBase.current = { session: prefill.session, base: latest.current };
    let next = !fresh || prefill.text ? joinPrefill(prefillBase.current!.base, prefill.text) : null;
    const held = endTypeahead();
    if (held) next = (next ?? latest.current) + held;
    const el = textRef.current;
    // A prefill is never a tap on the box itself — it is the orchestrator opening (the top-bar
    // button, O, the palette, a notification's Open, a quick-ask hand-off), on page load or a
    // reopen. On mobile that must not pop the on-screen keyboard over the page; the typed text (if
    // any) still lands, just unfocused, so a later explicit tap picks up where it left off.
    const autoFocusOk = !isMobile();
    if (next !== null && next !== latest.current) {
      pendingCaret.current = next.length; // the [value] layout effect focuses and puts the caret at the end
      pendingFocus.current = autoFocusOk;
      setValue(next);
      walk.current = NO_WALK; // text from outside the box is the new draft
    } else if (autoFocusOk && el && el.ownerDocument.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [prefill?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // A Quote click: append after whatever is already in the box (never losing it), then focus with
  // the caret at the end — the same caret handling as `prefill`, above, but with none of its
  // session bookkeeping (a quote is always a fresh, one-off append, never a continued typeahead).
  useLayoutEffect(() => {
    if (!insert) return;
    const next = appendQuote(latest.current, insert.text);
    pendingCaret.current = next.length; // the [value] layout effect below focuses and places it
    pendingFocus.current = true; // a Quote click is a direct tap, on any device
    setValue(next);
    walk.current = NO_WALK; // text from outside the box is the new draft
  }, [insert?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clicking anywhere in the chrome (border, padding, toolbar gap) focuses the textarea, so the
  // whole box behaves like one input. preventDefault keeps the existing caret/selection intact.
  const focusText = (e: MouseEvent) => {
    if (e.target instanceof HTMLElement && e.target.closest("button, input, textarea, [role='combobox']")) return;
    e.preventDefault();
    textRef.current?.focus();
  };

  // Rehydrate persisted attachments (stored as data URLs) into File objects on mount. Only once
  // this resolves do we start persisting — otherwise the empty initial `images` would overwrite
  // the stored attachments before they load back.
  useEffect(() => {
    if (!persistKey) return;
    let live = true;
    void draftFiles(persistKey).then((fs) => { if (live) { if (fs.length) setImages(fs); setHydrated(true); } });
    return () => { live = false; };
  }, [persistKey]);

  // Persist on every edit so a reload mid-compose loses nothing. Saves are CHAINED, not fired in
  // parallel: encoding an attachment is async, so a save started when the file was attached could
  // otherwise land after the clear-on-send and put the sent message back in the reopened box.
  const saves = useRef(Promise.resolve());
  useEffect(() => {
    if (persistKey && hydrated) saves.current = saves.current.then(() => saveDraft(persistKey, value, images));
  }, [persistKey, hydrated, value, images]);

  // Any file type — images, xml, docx, csv… the agent Reads them by path.
  const addImages = (files: Iterable<File>) => {
    const added = [...files];
    if (added.length) setImages((prev) => [...prev, ...added]);
  };
  const onPaste = (e: ClipboardEvent) => {
    // Pasted screenshots often arrive only via `items` (getAsFile), not `.files`.
    const files = [...e.clipboardData.items]
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (files.length) { e.preventDefault(); addImages(files); }
  };
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length) { e.preventDefault(); addImages(e.dataTransfer.files); }
  };

  // Never gated on a send in flight: a launch takes seconds (longer over the tailnet) and the box
  // must take the next message meanwhile — the log shows each one as "sending…" until the bridge
  // has it (running or queued), which is the receipt. (It used to go busy until the launch
  // returned, and Enter did nothing for those seconds.)
  // A tap on Send keeps the focus (and the phone's keyboard) in the box — see lib/viewport's
  // keepComposerFocus — so one tap sends once and the next message can be typed straight away.
  const canSubmit = Boolean(value.trim() || images.length);
  const submit = async (send: (text: string, images: File[]) => Promise<void> = onSubmit) => {
    if (!canSubmit) return;
    // Optimistic: fire and return so the parent can close instantly; it owns draft + errors.
    if (optimistic) return void send(value.trim(), images);
    // Clear NOW, not after onSubmit resolves: a box still holding the text you just sent reads as
    // "it didn't go". On failure the text (and attachments) come back — into the box if it is still
    // empty, else into the error line, so neither what you sent nor what you're typing is lost.
    const sent = { text: value.trim(), images };
    setValue("");
    setImages([]);
    walk.current = NO_WALK;
    if (persistKey) clearDraft(persistKey);
    setError(null);
    try {
      await send(sent.text, sent.images);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const empty = !latest.current.trim();
      setError(empty ? msg : `${msg} — not sent: “${sent.text}”`);
      if (empty) { setValue(sent.text); setImages(sent.images); }
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (picking && !e.nativeEvent.isComposing) {
      const n = matches.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((activeIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); pick(matches[activeIdx]!); return; }
      // preventDefault also keeps a host <dialog> from closing on this Escape.
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissedAt(trig!.start); return; }
    }
    // Enter sends, like a chat; Shift/⌘/Ctrl+Enter breaks the line. (It was ⌘+Enter to send.) A
    // textarea inserts the newline for Shift on its own; ⌘/Ctrl need it put in by hand. On a touch
    // screen Enter is left to the textarea (a newline) — see lib/viewport's enterSends.
    if (e.key === "Enter" && enterSends({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing }, isCoarse())) { e.preventDefault(); void submit(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const el = e.currentTarget as HTMLTextAreaElement;
      el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
      setValue(el.value);
      return;
    }
    // ↑/↓ walk the messages you sent here. A recalled message goes in whole with the caret at its END,
    // so on a multi-line one a further ↑ first climbs its lines (the first-line rule) before reaching
    // an older message — the same as a shell's multi-line history.
    const el = e.currentTarget as HTMLTextAreaElement;
    const dir = historyKey(
      { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing || e.keyCode === 229 },
      { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd, menuOpen: picking },
    );
    const step = dir && historyStep(walk.current, dir, history ?? [], el.value);
    if (!step) return;
    e.preventDefault();
    walk.current = step.walk;
    pendingCaret.current = step.text.length;
    if (step.text === el.value) el.setSelectionRange(step.text.length, step.text.length); // no re-render to place it
    setValue(step.text);
    setCaret(step.text.length);
  };
  // Cancel is an explicit dismissal, so drop the persisted draft too — otherwise it would
  // reopen on the next reload (open-state is derived from whether a draft exists).
  const cancel = () => { if (persistKey) clearDraft(persistKey); onCancel?.(); };

  const textarea = (
    <textarea
      ref={textRef}
      autoFocus={autoFocus && !isMobile()}
      rows={quick ? 3 : 2}
      aria-label={inputLabel}
      className={quick
        ? "placeholder:text-muted-foreground field-sizing-content max-h-40 min-h-[4.5rem] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-0.5 text-sm outline-none"
        : "placeholder:text-muted-foreground field-sizing-content max-h-48 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none"}
      placeholder={placeholder}
      value={value}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={picking}
      aria-controls={picking ? listId : undefined}
      aria-activedescendant={picking ? optionId(activeIdx) : undefined}
      onChange={(e) => {
        const t = prTrigger(e.target.value, e.target.selectionStart);
        if (t?.start !== dismissedAt) setDismissedAt(null); // a new (or no) `@` re-arms the picker
        setValue(e.target.value); setCaret(e.target.selectionStart); setActive(0); // an edit keeps the ↑/↓ walk: ↓ still returns to the draft
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
      onBlur={() => { if (trig) setDismissedAt(trig.start); }}
      onKeyDown={onKey}
      onPaste={onPaste}
    />
  );
  // Opens upward (chat boxes sit low) unless the box is near the top of the viewport (the new-draft box).
  const rect = picking ? (quick ? rootRef.current : textRef.current)?.getBoundingClientRect() : undefined;
  const mentions = picking && (
    // Inline, not a portaled popover: the composer lives in modal <dialog>s (top layer) and the
    // orchestrator's PiP window, where a body portal would sit behind or outside it. The quick variant
    // is the exception — its host clips (overflow-hidden, for the morph) and is in neither — so it goes
    // to its own document's body, fixed just above the box.
    <div
      data-slot="chat-composer-mentions"
      className={cn(
        "bg-popover text-popover-foreground z-50 w-full max-w-md rounded-lg border p-1 shadow-menu",
        quick ? "fixed" : cn("absolute left-0", (rect?.top ?? 0) < 280 ? "top-full mt-1" : "bottom-full mb-1"),
      )}
      style={quick && rect ? { left: rect.left, bottom: (textRef.current?.ownerDocument.defaultView?.innerHeight ?? 0) - rect.top + 4, width: rect.width } : undefined}
    >
    <ul id={listId} role="listbox" aria-label="Pull requests" className="max-h-64 overflow-y-auto">
      {matches.map((r, i) => (
        <li
          key={`${r.repo}#${r.number}`}
          id={optionId(i)}
          role="option"
          aria-selected={i === activeIdx}
          className={cn("flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm", i === activeIdx && "bg-accent text-accent-foreground")}
          onMouseDown={(e) => e.preventDefault()} // keep the textarea's focus + caret
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(r)}
        >
          <span className="text-muted-foreground shrink-0 font-mono text-xs">#{r.number}</span>
          <span className="min-w-0 flex-1 truncate">{r.title}</span>
          {repoCount > 1 && <span className="text-muted-foreground shrink-0 text-xs">{r.repo}</span>}
          {r.state !== "open" && <span className="text-muted-foreground shrink-0 rounded border px-1 text-[10px]">{r.state}</span>}
        </li>
      ))}
    </ul>
    </div>
  );

  return (
    <div ref={rootRef} className="relative">
      <div
        className={cn(quick ? "cursor-text" : "bg-card focus-within:border-ring focus-within:ring-ring/40 cursor-text rounded-lg border transition-[color,box-shadow] focus-within:ring-2", className)}
        onMouseDown={focusText}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 p-2 pb-0">
            {images.map((f, i) => <Thumb key={i} file={f} onRemove={() => setImages((p) => p.filter((_, j) => j !== i))} />)}
          </div>
        )}
        {quick ? (
          <div className="flex items-start gap-2 px-3 pt-2.5">
            {icon}
            {textarea}
          </div>
        ) : textarea}
        <div data-slot="chat-composer-toolbar" className={cn("flex min-w-0 items-center gap-1", quick ? "px-2 pt-1 pb-2" : "p-2 pt-0")}>
          {leading && <div data-slot="chat-composer-leading" className="min-w-0 flex-1 overflow-hidden">{leading}</div>}
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addImages(e.target.files ?? []); e.target.value = ""; }} />
          <div data-slot="chat-composer-actions" className="ml-auto flex shrink-0 items-center gap-1">
            {onCancel && <Button type="button" size="sm" variant="ghost" onClick={cancel}>Cancel</Button>}
            {action ?? (
              <Button type="button" size="icon" variant="ghost" className="text-muted-foreground size-8" title="Attach files" onClick={() => fileRef.current?.click()}>
                <Paperclip className="size-4" />
              </Button>
            )}
            {alt && (
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={!canSubmit} title={alt.title} onMouseDown={keepComposerFocus} onClick={() => void submit(alt.onSubmit)}>
                {alt.label}
              </Button>
            )}
            {quick ? (
              <Button type="button" size="sm" variant="secondary" className="h-7 gap-1.5 pr-1.5 pl-2.5" disabled={!canSubmit} title="Send (Enter)" aria-label="Send" onMouseDown={keepComposerFocus} onClick={() => void submit()}>
                Send
                <Shortcut id="send" />
              </Button>
            ) : (
              // Narrow: the filled square read as far bigger than its ghost neighbours (attach, the
              // model picker, the context ring), which show only an icon. The fill shrinks to a 28px
              // chip inside a transparent button, so the touch target stays 44px. Never in the PiP
              // window, which is desktop-only and has no touch target to grow for.
              <Button type="button" size="icon" className={cn("size-8", !pip && "max-md:border-transparent max-md:bg-transparent max-md:hover:bg-transparent pointer-coarse:max-md:min-w-11")} disabled={!canSubmit} title="Send (Enter)" aria-label="Send" onMouseDown={keepComposerFocus} onClick={() => void submit()}>
                <span className={cn("inline-flex items-center justify-center", !pip && "max-md:bg-primary max-md:size-7 max-md:rounded-md")}><ArrowUp className="size-4" /></span>
              </Button>
            )}
          </div>
        </div>
      </div>
      {mentions && (quick && textRef.current ? createPortal(mentions, textRef.current.ownerDocument.body) : mentions)}
      {error && <p data-slot="chat-composer-error" className={cn("text-destructive text-xs break-words", quick ? "border-t px-3 py-1.5" : "mt-1 px-1")}>{error}</p>}
      {footer}
    </div>
  );
}

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/");
  // Create + revoke the object URL inside the effect so StrictMode's dev remount doesn't leave a
  // revoked (blank) src behind — the effect re-runs and mints a fresh URL.
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!isImage) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, isImage]);
  return (
    <div className="group relative size-14 overflow-hidden rounded-md border" title={file.name}>
      {isImage
        // url is a local blob: — not minted yet on the very first render, so skip the lightbox
        // until the effect above fills it in.
        ? (url && <ExpandableImage src={url} alt={file.name} downloadName={file.name} className="size-full" imgClassName="size-full object-cover" cornerClassName="bottom-1 right-1" />)
        // Non-image (xml, docx, …): no preview to render, so show the icon + extension.
        : (
          <div data-slot="chat-composer-file" className="text-muted-foreground flex size-full flex-col items-center justify-center gap-0.5 p-1">
            <FileText className="size-4 shrink-0" />
            <span className="w-full truncate text-center text-[10px]">{file.name}</span>
          </div>
        )}
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="bg-background/80 text-foreground hover:bg-background absolute top-0.5 right-0.5 rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
