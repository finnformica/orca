import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cpu, GitMerge, Globe, KeyRound, ListX, Loader2, Minimize2, Paperclip, Pencil, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/FormCard";
import type { ComposerCommand } from "@/components/ChatComposer";
import { RenameDialog } from "@/views/WorkstreamActions";
import { mergeWhenGreen, previewKeyOf, previewStatus, testLocally, type Row } from "@/store";
import { actionFailed } from "@/lib/notificationStore";
import { PortalContainer } from "@/lib/utils";
import { api } from "@/api";
import { SLASH_COMMANDS, previewHref, type SlashCommandId, type SlashContext } from "@/workstream";

// The composer's `/` menu: the registry's UI half. The pure half (name, description, where each
// applies) is `SLASH_COMMANDS` in workstream.ts; here each id gets its icon and its action, which
// calls an action the app already has. A new command is one entry in each. No command sends a
// chat message.

const ICONS: Record<SlashCommandId, ReactNode> = {
  compact: <Minimize2 />, secret: <KeyRound />, stop: <Square />, model: <Cpu />, attach: <Paperclip />,
  "clear-queue": <ListX />, preview: <Globe />, merge: <GitMerge />, rename: <Pencil />,
};

/** What the chat panel hands in: the facts that decide which commands apply, and the panel's own verbs. */
export type SlashHost = {
  row: Row;
  ctx: SlashContext;
  onCompact: () => Promise<void>;
  onStop: () => Promise<void>;
  onClearQueue: () => Promise<void>;
  openModel: () => void;
};

/** The commands for this chat (every one of its kind; one that does not apply now carries its
 *  reason as `disabled`) and the UI they open: the merge and rename
 *  dialogs and a one-line notice under the composer (`ui`), and the `/secret` card, drawn inside
 *  the composer's box above the text while it is open (`widget`, ChatComposer's `top`). */
export function useSlashCommands(host: SlashHost): { commands: ComposerCommand[]; ui: ReactNode; widget: ReactNode } {
  const { row, ctx } = host;
  const [dialog, setDialog] = useState<null | "secret" | "merge" | "rename">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fail = (action: string, e: unknown) => actionFailed({ action, title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }, e);

  const actions: Record<SlashCommandId, (box: { attach: () => void }) => void> = {
    compact: () => void host.onCompact(),
    stop: () => void host.onStop().catch((e) => fail("Stop agent", e)),
    "clear-queue": () => void host.onClearQueue().then(() => setNotice("Queue cleared"), (e) => fail("Clear queue", e)),
    model: () => host.openModel(),
    attach: (box) => box.attach(),
    secret: () => setDialog("secret"),
    merge: () => setDialog("merge"),
    rename: () => setDialog("rename"),
    preview: () => void (async () => {
      try {
        const key = previewKeyOf(row);
        const svcs = key ? await previewStatus(key).catch(() => []) : [];
        const open = svcs.find((s) => s.open) ?? svcs[0];
        if (open && svcs.every((s) => s.ready)) {
          window.open(previewHref(open, window.location.hostname), "_blank", "noreferrer");
          setNotice("Preview opened");
        } else if (svcs.length) setNotice("Preview is starting");
        else { await testLocally(row); setNotice("Preview started"); }
      } catch (e) { fail("Preview", e); }
    })(),
  };
  // The memoized commands call the newest render's actions (the row and the panel's verbs change).
  const live = useRef(actions);
  live.current = actions;
  const shown = SLASH_COMMANDS.filter((c) => c.shows(ctx)).map((c) => ({ c, why: c.unavailable(ctx) }));
  const key = shown.map(({ c, why }) => `${c.id}:${why ?? ""}`).join(",");
  const commands = useMemo(() => shown.map(({ c, why }): ComposerCommand => ({
    name: c.id, description: c.description, icon: ICONS[c.id], disabled: why ?? undefined, run: (box) => live.current[c.id](box),
  })), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A notice fades after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const ui = (
    <SlashPortal>
      {!ctx.orchestrator && (
        <MergeDialog row={row} open={dialog === "merge"} onClose={() => setDialog(null)}
          onConfirm={async () => {
            setDialog(null);
            try { await mergeWhenGreen(row); setNotice(`PR #${row.prNumber} merges when green`); } catch (e) { fail("Merge when green", e); }
          }} />
      )}
      {/* Mounted only while open: its title field has autoFocus, and a closed one mounted beside the
          composer pulled the focus away from the Chat tab's box (a focus fight, never settled). */}
      {dialog === "rename" && <RenameDialog row={row} open onClose={() => setDialog(null)} />}
      {notice && (
        <div role="status" data-slot="slash-notice" className="bg-muted text-muted-foreground mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs">
          <span className="min-w-0 truncate">{notice}</span>
          <Button type="button" size="icon" variant="ghost" className="-mr-1 size-5" aria-label="Dismiss" onClick={() => setNotice(null)}><X className="size-3" /></Button>
        </div>
      )}
    </SlashPortal>
  );
  const widget = dialog === "secret"
    ? <SecretWidget onCancel={() => setDialog(null)} onSaved={(ref) => { setDialog(null); setNotice(`Secret ${ref} saved`); }} />
    : null;
  return { commands, ui, widget };
}

/** Radix portals to <body> by default, which is inert behind a native modal <dialog> (the card's
 *  terminal). Inside one, its dialogs portal into that <dialog>; elsewhere they keep the app's
 *  container (the orchestrator's PiP window) or <body>. */
function SlashPortal({ children }: { children: ReactNode }) {
  const outer = useContext(PortalContainer);
  const anchor = useRef<HTMLSpanElement>(null);
  const [inDialog, setInDialog] = useState<HTMLElement | undefined>();
  useEffect(() => { setInDialog(anchor.current?.closest("dialog") ?? undefined); }, []);
  return (
    <>
      <span ref={anchor} hidden />
      <PortalContainer.Provider value={inDialog ?? outer}>{children}</PortalContainer.Provider>
    </>
  );
}

/** `/secret`: a compact card inside the composer's box, above the text: a name and a value, saved
 *  encrypted in the "chat" scope. The text and Send stay usable below it, and a message sent then is
 *  the draft only. The value lives only in this card's state and the request body: never in the
 *  composer, its draft, a message or the turn log. Enter in a field saves; Esc or ✕ closes it.
 *  Tab goes Name → Value → Save → the text (the reveal toggle and ✕ are out of the Tab order). */
function SecretWidget({ onCancel, onSaved }: { onCancel: () => void; onSaved: (ref: string) => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) { setError("Give the secret a name."); return; }
    if (!value) { setError("Give the secret a value."); return; }
    setBusy(true); setError(null);
    try {
      const { ref } = await api.saveSecret({ name: name.trim(), scope: "chat", value });
      setValue("");
      onSaved(ref);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const cancel = () => { setValue(""); onCancel(); };
  return (
    <div data-slot="slash-secret" className="bg-muted/40 mx-2 mt-2 cursor-auto rounded-md border px-2.5 py-2 text-[13px]"
      // preventDefault also keeps a host <dialog> (the card's terminal) from closing on this Esc.
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } }}>
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-xs">
        <KeyRound className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">Save a secret</span>
        <span className="text-muted-foreground min-w-0 truncate">Stored encrypted. The agent sees only its name.</span>
        <Button type="button" size="icon" variant="ghost" tabIndex={-1} className="text-muted-foreground -my-1 -mr-1 ml-auto size-6 shrink-0" aria-label="Close"
          disabled={busy} onClick={cancel} data-slot="slash-secret-cancel"><X className="size-3.5" /></Button>
      </div>
      <form className="flex flex-wrap items-start gap-2" noValidate autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Input id="slash-secret-name" data-slot="slash-secret-name" aria-label="Name" autoFocus className="min-w-0 flex-1 basis-32 font-mono" autoComplete="off" spellCheck={false}
          value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <div className="min-w-0 flex-[2] basis-44">
          <SecretInput compact common={{ id: "slash-secret-value", name: "value", "aria-label": "Value" }} placeholder="Value" value={value} onChange={setValue} />
        </div>
        <Button type="submit" size="sm" disabled={busy} className="shrink-0" data-slot="slash-secret-save">{busy && <Loader2 className="size-3.5 animate-spin" />}Save</Button>
      </form>
      {error && <p className="text-destructive mt-1.5 text-xs break-words" role="alert" data-slot="slash-secret-error">{error}</p>}
    </div>
  );
}

/** `/merge`: confirm, then mark the PR for Orca's merge queue (store.mergeWhenGreen). */
function MergeDialog({ row, open, onClose, onConfirm }: { row: Row; open: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-slot="slash-merge">
        <DialogHeader>
          <DialogTitle>Merge PR #{row.prNumber} when green?</DialogTitle>
          <DialogDescription>Orca squash-merges “{row.title}” when every check passes and GitHub says it is mergeable. The repo's merge policy applies.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" data-slot="slash-merge-confirm" onClick={() => void onConfirm()}>Merge when green</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
