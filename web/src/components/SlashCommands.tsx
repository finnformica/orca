import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Cpu, Eye, EyeOff, GitMerge, Globe, KeyRound, ListX, Loader2, Minimize2, Paperclip, Pencil, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ComposerCommand } from "@/components/ChatComposer";
import { RenameDialog } from "@/views/WorkstreamActions";
import { mergeWhenGreen, previewKeyOf, previewStatus, testLocally, type Row } from "@/store";
import { actionFailed } from "@/lib/notificationStore";
import { cn, PortalContainer } from "@/lib/utils";
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

/** The commands for this chat (only those that apply) and the UI they open: the secret and merge
 *  dialogs, the rename dialog and a one-line notice under the composer. */
export function useSlashCommands(host: SlashHost): { commands: ComposerCommand[]; ui: ReactNode } {
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
  const key = SLASH_COMMANDS.filter((c) => c.applies(ctx)).map((c) => c.id).join(",");
  const commands = useMemo(() => SLASH_COMMANDS.filter((c) => c.applies(ctx)).map((c): ComposerCommand => ({
    name: c.id, description: c.description, icon: ICONS[c.id], run: (box) => live.current[c.id](box),
  })), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A notice fades after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const ui = (
    <SlashPortal>
      <SecretDialog open={dialog === "secret"} onClose={() => setDialog(null)} onSaved={(ref) => { setDialog(null); setNotice(`Secret ${ref} saved`); }} />
      {!ctx.orchestrator && (
        <MergeDialog row={row} open={dialog === "merge"} onClose={() => setDialog(null)}
          onConfirm={async () => {
            setDialog(null);
            try { await mergeWhenGreen(row); setNotice(`PR #${row.prNumber} merges when green`); } catch (e) { fail("Merge when green", e); }
          }} />
      )}
      {!ctx.orchestrator && <RenameDialog row={row} open={dialog === "rename"} onClose={() => setDialog(null)} />}
      {notice && (
        <div role="status" data-slot="slash-notice" className="bg-muted text-muted-foreground mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs">
          <span className="min-w-0 truncate">{notice}</span>
          <Button type="button" size="icon" variant="ghost" className="-mr-1 size-5" aria-label="Dismiss" onClick={() => setNotice(null)}><X className="size-3" /></Button>
        </div>
      )}
    </SlashPortal>
  );
  return { commands, ui };
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

/** `/secret`: a name and a value, saved encrypted in the "chat" scope. The value lives only in this
 *  dialog's state and the request body: never in the composer, its draft or a message. */
function SecretDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (ref: string) => void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setValue(""); setShown(false); setError(null); } }, [open]);
  const save = async () => {
    if (!name.trim()) { setError("Give the secret a name."); return; }
    if (!value) { setError("Give the secret a value."); return; }
    setBusy(true); setError(null);
    try {
      const { ref } = await api.saveSecret({ name: name.trim(), scope: "chat", value });
      setValue("");
      onSaved(ref);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setValue(""); onClose(); } }}>
      <DialogContent data-slot="slash-secret">
        <DialogHeader>
          <DialogTitle>Save a secret</DialogTitle>
          <DialogDescription>Stored encrypted. The agent sees only its name.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="slash-secret-name">Name</Label>
            <Input id="slash-secret-name" data-slot="slash-secret-name" autoFocus className="font-mono" autoComplete="off" spellCheck={false}
              value={name} onChange={(e) => setName(e.target.value)} placeholder="stripe-test-key" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="slash-secret-value">Value</Label>
            <div className="relative">
              <Input id="slash-secret-value" data-slot="slash-secret-value" type={shown ? "text" : "password"} autoComplete="new-password" spellCheck={false}
                autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true" className={cn("pr-9 font-mono")}
                value={value} onChange={(e) => setValue(e.target.value)} />
              <Button type="button" size="icon" variant="ghost" className="text-muted-foreground absolute top-0 right-0 size-8" aria-label={shown ? "Hide the value" : "Show the value"} aria-pressed={shown}
                data-slot="slash-secret-reveal" onClick={() => setShown(!shown)}>
                {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
          </div>
          {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy} data-slot="slash-secret-save">{busy && <Loader2 className="size-3.5 animate-spin" />}Save secret</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
