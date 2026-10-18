// The New-draft box (the sidebar's Add New dialog): a prompt, its repo and model, and "New chat".
import { useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { SquareTerminal } from "lucide-react";
import { draftRepoAtom, openTerminalAtom } from "@/lib/atoms";
import { createWorkstream, defaultInstanceFor, instanceChoices, undoDraft, useAgentProviders, useRepos, type OptimisticDraft } from "../store";
import { draftInstance } from "../workstream";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChatComposer } from "@/components/ChatComposer";
import { ModelPicker } from "@/components/ModelPicker";
import { Tip } from "@/components/ui/tip";
import { AUTO_MODEL, modelLabel, providerOfModel } from "../../../shared/models";

/** `onSent` hands each sent draft to the host (the Add New dialog closes and shows Undo itself);
 *  without it the box keeps its own inline Undo. */
export function NewDraft({ onSent, autoFocus = false }: { onSent?: (draft: OptimisticDraft) => void; autoFocus?: boolean } = {}) {
  const repos = useRepos();
  const providers = useAgentProviders();
  const [repo, setRepo] = useAtom(draftRepoAtom);
  const active = repo || repos[0]?.name || "";
  // The model for the new draft. "Auto" by default: the draft goes through the orchestrator, which
  // writes the brief and picks the model for the task (the scarce one only where it counts). Pick a
  // model to bypass it and launch directly, as before. Falls back when the config arrives (or
  // changes) and the chosen model's CLI isn't installed here.
  const [model, setModel] = useState<string>(AUTO_MODEL);
  useEffect(() => { if (model !== AUTO_MODEL && providers.length && !providers.includes(providerOfModel(model) ?? "claude")) setModel(AUTO_MODEL); }, [providers, model]);
  // The card + Undo appear the instant you submit — createWorkstream paints an optimistic draft and
  // does the worktree/agent work in the background. We keep the Undo affordance for ~6s so a mis-sent
  // draft (wrong repo) can be reverted; Undo discards it (kills the run, removes the worktree+branch).
  const [undoable, setUndoable] = useState<OptimisticDraft | null>(null);
  useEffect(() => {
    if (!undoable) return;
    const t = setTimeout(() => setUndoable(null), 6000);
    return () => clearTimeout(t);
  }, [undoable]);
  // "New chat": a composer opens at once; the worktree, card and first run all start on submit,
  // optimistically, and the card's terminal opens as soon as its branch exists.
  const openTerminal = useSetAtom(openTerminalAtom);
  const [chatOpen, setChatOpen] = useState(false);

  const sent = (draft: OptimisticDraft) => (onSent ? onSent(draft) : setUndoable(draft));
  return (
    <ChatComposer
      autoFocus={autoFocus}
      persistKey="orca.newDraft"
      repo={active}
      placeholder="Describe a feature…"
      onSubmit={async (text, images) => {
        sent(createWorkstream(active, text, images, model, { instance: draftInstance(model, instanceChoices(), defaultInstanceFor(active)) }));
      }}
      footer={undoable && (
        <p className="text-muted-foreground mt-1 flex items-center gap-1.5 px-1 text-xs">
          Sent to <span className="text-foreground font-medium">{undoable.repo}</span>
          <button
            type="button"
            className="text-foreground underline underline-offset-2 hover:no-underline"
            onClick={() => { void undoDraft(undoable); setUndoable(null); }}
          >
            Undo
          </button>
        </p>
      )}
      leading={
        <div className="flex min-w-0 w-full items-center overflow-hidden">
          <Select value={active} onValueChange={setRepo}>
            <SelectTrigger size="sm" className="text-muted-foreground hover:bg-accent hover:text-foreground min-w-0 flex-1 border-0 shadow-none transition-colors focus-visible:ring-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <ModelPicker auto label="Model" value={model} onChange={setModel} className="max-w-40 flex-1" />
        </div>
      }
      action={
        <>
          <Tip label="New chat (a conversation, not a task)">
            <Button type="button" size="icon" variant="ghost" className="text-muted-foreground size-8" onClick={() => setChatOpen(true)} aria-label="New chat">
              <SquareTerminal className="size-4" />
            </Button>
          </Tip>
          <NewChatDialog
            open={chatOpen}
            onClose={() => setChatOpen(false)}
            repo={active}
            model={model}
            onSubmit={async (text, images) => {
              setChatOpen(false);
              sent(createWorkstream(active, text, images, model, { chat: true, onCreated: (branch) => openTerminal(`${active}::${branch}`) }));
            }}
          />
        </>
      }
    />
  );
}

// The blank chat's first message. A native <dialog> like the terminal's; the composer is the same
// one the terminal uses, so paste/drop attachments and Enter-to-send work the same.
function NewChatDialog({ open, onClose, repo, model, onSubmit }: { open: boolean; onClose: () => void; repo: string; model: string; onSubmit: (text: string, images: File[]) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }} className="bg-card text-foreground m-auto w-[90vw] max-w-2xl rounded-lg border p-0 shadow-modal backdrop:bg-black/50">
      <div className="flex flex-col gap-2 p-3">
        <div className="text-muted-foreground text-xs">New chat · {repo} · {modelLabel(model)}</div>
        {open && <ChatComposer autoFocus repo={repo} persistKey="orca.newChat" placeholder="Ask anything…" onSubmit={onSubmit} onCancel={onClose} />}
      </div>
    </dialog>
  );
}
