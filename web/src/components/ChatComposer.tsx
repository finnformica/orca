import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowUp, FileText, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrRefs } from "@/store";
import { filterPrRefs, insertPrRef, prRefLabel, prTrigger, type PrRef } from "@/workstream";
import { cn } from "@/lib/utils";
import { clearDraft, draftFiles, loadDraft, saveDraft } from "@/lib/composerDraft";

// The one chat input, shared by the new-draft box and the follow-up box. A single bordered
// "chatbox" (à la Claude/ChatGPT) wrapping image thumbnails, the textarea, and a bottom toolbar
// with the repo selector (via `leading`) on the left and an icon send button on the right.
// Accepts files of any type by paste, drag-drop, or the paperclip picker; Enter sends; Shift/⌘/Ctrl+Enter breaks the line.
// Owns its own text + attachments; with a `persistKey` it survives page reloads (localStorage).
/** Shell-style history step: ↑ walks toward older (from newest when not yet walking), ↓ toward newer
 *  and off the end back to an empty box (null). Pure, so it's unit-tested without a DOM. */
export function stepHistory(idx: number | null, dir: "up" | "down", len: number): number | null {
  if (len === 0) return null;
  if (dir === "up") return idx === null ? len - 1 : Math.max(0, idx - 1);
  return idx === null || idx >= len - 1 ? null : idx + 1; // ↓ past newest → cleared box
}

export function ChatComposer({
  persistKey, onSubmit, placeholder, leading, footer, onCancel, autoFocus, optimistic, history, action, alt, className, repo,
}: {
  // The repo this conversation is about (a workstream's, the new-draft box's selection). The # PR
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
  // Past submissions (oldest→newest) recallable with ↑/↓ from an empty box — resend a prior prompt.
  history?: string[];
}) {
  const [value, setText] = useState(() => (persistKey ? loadDraft(persistKey).text : ""));
  // What the box holds as of the last edit, committed or not: a send that fails fast can land before
  // React has rendered the clear, so the textarea's DOM value would still read as the sent text.
  const latest = useRef(value);
  const setValue = (v: string) => { latest.current = v; setText(v); };
  const [histIdx, setHistIdx] = useState<number | null>(null); // position while walking `history`, else null
  const [images, setImages] = useState<File[]>([]);
  const [hydrated, setHydrated] = useState(!persistKey);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // # PR picker: the `#query` at the caret lists the board's cached PRs (open first). Escape
  // dismisses it for THAT `#` (until a new one is typed); a pick replaces the query with the ref.
  const { refs, repoCount } = usePrRefs();
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
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
    setDismissedAt(trig.start); // `#6101 ` still parses as a trigger; a pick is done with it
    setValue(next.text);
    setCaret(next.caret);
    setHistIdx(null);
  };
  // Put the caret after an inserted ref once React has written the new value.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && pendingCaret.current !== null) { el.focus(); el.setSelectionRange(pendingCaret.current, pendingCaret.current); pendingCaret.current = null; }
  }, [value]);

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
    setHistIdx(null);
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
  // Recall a history entry (or clear to empty at idx null) into the box.
  const recall = (idx: number | null) => { setHistIdx(idx); setValue(idx === null ? "" : (history?.[idx] ?? "")); };
  const onKey = (e: KeyboardEvent) => {
    if (picking && !e.nativeEvent.isComposing) {
      const n = matches.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((activeIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n); return; }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); pick(matches[activeIdx]!); return; }
      // preventDefault also keeps a host <dialog> from closing on this Escape.
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissedAt(trig!.start); return; }
    }
    // Enter sends, like a chat; Shift/⌘/Ctrl+Enter breaks the line. (It was ⌘+Enter to send.) A
    // textarea inserts the newline for Shift on its own; ⌘/Ctrl need it put in by hand.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); return; }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const el = e.currentTarget as HTMLTextAreaElement;
      el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
      setValue(el.value);
      return;
    }
    const len = history?.length ?? 0;
    if (!len) return;
    // ↑/↓ walk past follow-ups — but only from an empty box (or once already walking), so ↑ never
    // clobbers a draft or hijacks normal caret movement inside multiline text.
    if (e.key === "ArrowUp" && (value === "" || histIdx !== null)) { e.preventDefault(); recall(stepHistory(histIdx, "up", len)); }
    else if (e.key === "ArrowDown" && histIdx !== null) { e.preventDefault(); recall(stepHistory(histIdx, "down", len)); }
  };
  // Cancel is an explicit dismissal, so drop the persisted draft too — otherwise it would
  // reopen on the next reload (open-state is derived from whether a draft exists).
  const cancel = () => { if (persistKey) clearDraft(persistKey); onCancel?.(); };

  return (
    <div className="relative">
      <div
        className={cn("bg-card focus-within:border-ring focus-within:ring-ring/50 cursor-text rounded-md border shadow-sm transition-[color,box-shadow] focus-within:ring-[3px]", className)}
        onMouseDown={focusText}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 p-2 pb-0">
            {images.map((f, i) => <Thumb key={i} file={f} onRemove={() => setImages((p) => p.filter((_, j) => j !== i))} />)}
          </div>
        )}
        <textarea
          ref={textRef}
          autoFocus={autoFocus}
          rows={2}
          className="placeholder:text-muted-foreground field-sizing-content max-h-48 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none"
          placeholder={placeholder}
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={picking}
          aria-controls={picking ? listId : undefined}
          aria-activedescendant={picking ? optionId(activeIdx) : undefined}
          onChange={(e) => {
            const t = prTrigger(e.target.value, e.target.selectionStart);
            if (t?.start !== dismissedAt) setDismissedAt(null); // a new (or no) `#` re-arms the picker
            setValue(e.target.value); setCaret(e.target.selectionStart); setActive(0); setHistIdx(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onBlur={() => { if (trig) setDismissedAt(trig.start); }}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div data-slot="chat-composer-toolbar" className="flex min-w-0 items-center gap-1 p-2 pt-0">
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
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={!canSubmit} title={alt.title} onClick={() => void submit(alt.onSubmit)}>
                {alt.label}
              </Button>
            )}
            <Button type="button" size="icon" className="size-8" disabled={!canSubmit} title="Send (Enter)" onClick={() => void submit()}>
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      {picking && (
        // Inline, not a portaled popover: the composer lives in modal <dialog>s (top layer) and the
        // orchestrator's PiP window, where a body portal would sit behind or outside it. Opens upward
        // (chat boxes sit low) unless the box is near the top of the viewport (the new-draft box).
        <div
          className={cn(
            "bg-popover text-popover-foreground absolute left-0 z-50 w-full max-w-md rounded-md border p-1 shadow-md",
            (textRef.current?.getBoundingClientRect().top ?? 0) < 280 ? "top-full mt-1" : "bottom-full mb-1",
          )}
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
      )}
      {error && <p className="text-destructive mt-1 px-1 text-xs break-words">{error}</p>}
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
        ? <img src={url} alt={file.name} className="size-full object-cover" />
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
        className="bg-background/80 text-foreground hover:bg-background absolute top-0.5 right-0.5 rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
