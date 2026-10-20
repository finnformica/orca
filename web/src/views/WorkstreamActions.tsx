import { createPortal } from "react-dom";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRightLeft, BellRing, Bot, Check, CheckCheck, ChevronDown, CircleX, ExternalLink, FolderOpen, GitBranch, GitMerge, GitPullRequestArrow, GitPullRequestDraft, Globe,
  Link, Loader2, MessageSquare, MessageSquarePlus, MoreVertical, Pencil, Send, ShieldCheck, ShieldOff, Sparkles, Square, SquareTerminal, Tag, Trash2, Wrench, X, XCircle, Zap, type LucideIcon,
} from "lucide-react";
import {
  addPreviewLabel, addressPr, autoMerge, baseBranch, closePr, convertToDraft, discardDraft, ensureWorktree, followUp, instanceChoices, markReady, moveWorkstream, previewConfigured, thisInstance,
  cliCommand, disableAutoMerge, merge, modelFor, promote, rename, resolveConflicts, sendSlack, setCardModel, setVerified, slackChannel, staleHours, stopAgent, suggestTitle, useCachedReviewDigest, useRepos, useReviewDigest, writeSlackClipboard, type Row,
} from "../store";
import {
  detailPath, failingCiUrl, firstLine, orchestratorAbout, prMarkdownLink, quickActions, reviewProblems, shouldBump, slackClipboard, verifiedState, workstreamMenu, type MenuItemId, type QuickActionId,
} from "../workstream";
import { canVerify } from "./VerifiedButton";
import { reviewSig } from "./Review";
import { ActionButton } from "@/components/ActionButton";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import { actionFailed } from "@/lib/notificationStore";
import { confirmDialog, copyText, type ConfirmOptions } from "@/lib/dialogs";
import { ChatComposer } from "@/components/ChatComposer";
import { clearDraft, hasDraft } from "@/lib/composerDraft";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ModelPicker";
import { BottomSheet } from "@/components/BottomSheet";
import { useNarrow } from "@/lib/viewport";
import { navigate } from "@/lib/route";
import { openOrchestrator } from "@/lib/orchestratorOpen";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// One organised action menu for every actionable workstream (open PR or local branch), in Finn's
// order: Open ▸, Copy ▸, Merge ▸, PR ▸, Agent ▸, Slack ▸, then Verified, Rename… and Close PR /
// Discard last, in red. Which items show is pure (workstream.workstreamMenu): an item that does not
// apply is left out, and an empty submenu is not shown.
// localStorage key for a row's in-progress follow-up draft; whether one exists also drives
// whether the composer auto-reopens after a reload (see FollowUpComposer).
const followUpDraftKey = (row: Row) => `orca.followup.${row.repo}::${row.branch}`;

// The icon a quick action wears (every quick action is icon-only, its label the tooltip).
const QUICK_ICONS: Record<QuickActionId, LucideIcon> = {
  createPr: GitPullRequestArrow, markReady: CheckCheck, addressPr: Wrench, slack: Send, merge: GitMerge, autoMerge: Zap, disableAutoMerge: Zap,
};

// The menu's parts. On a desktop they are the Radix menu's own items (the ⋯ dropdown and the
// right-click menu); on a phone the SAME fragment renders as a bottom sheet's large touch rows, each
// with its icon — one list, so the dropdown and the sheet can't drift. A submenu becomes a labelled
// group in the sheet (a disabled one a disabled fieldset). `SheetMenu` carries the sheet's close.
const SheetMenu = createContext<(() => void) | null>(null);
type Select = (e: Event) => void;
const SHEET_ROW = "active:bg-accent flex min-h-12 w-full items-center gap-3 rounded-md px-2 text-left text-[15px] outline-none select-none focus-visible:bg-accent disabled:opacity-50";

// `busy` scopes a spinner (and the disable that blocks a double-click) to THIS item alone — every
// other item, the card link, the chat and the menu itself stay usable while one action runs.
function Item({ icon: Icon, onSelect, disabled, busy, className, children }: { icon?: LucideIcon; onSelect?: Select; disabled?: boolean; busy?: boolean; className?: string; children: ReactNode }) {
  const close = useContext(SheetMenu);
  const isDisabled = disabled || busy;
  if (!close) return (
    <DropdownMenuItem onSelect={onSelect} disabled={isDisabled} className={className}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {busy && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
    </DropdownMenuItem>
  );
  return (
    <button type="button" role="menuitem" data-slot="sheet-item" disabled={isDisabled} className={cn(SHEET_ROW, className)}
      onClick={() => { const e = new Event("select", { cancelable: true }); onSelect?.(e); if (!e.defaultPrevented) close(); }}>
      {busy ? <Loader2 className="text-muted-foreground size-5 shrink-0 animate-spin" /> : (Icon && <Icon className="text-muted-foreground size-5 shrink-0" />)}
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function CheckItem({ icon: Icon, checked, onCheckedChange, onSelect, children }: { icon?: LucideIcon; checked: boolean; onCheckedChange: (c: boolean) => void; onSelect?: Select; children: ReactNode }) {
  const close = useContext(SheetMenu);
  if (!close) return <DropdownMenuCheckboxItem checked={checked} onCheckedChange={onCheckedChange} onSelect={onSelect}>{children}</DropdownMenuCheckboxItem>;
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} data-slot="sheet-item" className={SHEET_ROW}
      onClick={() => { const e = new Event("select", { cancelable: true }); onCheckedChange(!checked); onSelect?.(e); if (!e.defaultPrevented) close(); }}>
      {Icon && <Icon className="text-muted-foreground size-5 shrink-0" />}<span className="min-w-0 flex-1">{children}</span>
      {checked && <Check className="size-5 shrink-0" />}
    </button>
  );
}

function Sub({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  const close = useContext(SheetMenu);
  if (!close) return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  return (
    <fieldset role="group" aria-label={label} disabled={disabled} className="m-0 min-w-0 border-0 p-0">
      <div aria-hidden="true" className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium tracking-wide uppercase">{label}</div>
      {children}
    </fieldset>
  );
}

function Label({ children }: { children: ReactNode }) {
  return useContext(SheetMenu) ? null : <DropdownMenuLabel>{children}</DropdownMenuLabel>; // the sheet's group already says it
}

function Sep() {
  return useContext(SheetMenu) ? <div role="separator" className="bg-border -mx-2 my-1 h-px" /> : <DropdownMenuSeparator />;
}

// Merge asks first everywhere it is offered (the menus and the quick action): it can't be undone.
const mergeConfirm = (row: Row): ConfirmOptions => ({
  title: row.prNumber ? `Merge PR #${row.prNumber}?` : `Merge ${row.branch}?`,
  description: row.prNumber
    ? `Merge "${row.title}" into ${baseBranch(row.repo)}. You cannot undo this.`
    : `Merge ${row.branch} into ${baseBranch(row.repo)} locally. You cannot undo this.`,
  confirmLabel: "Merge",
});

// `compact` renders the toolbar as icon-only buttons (the Agents row, a narrow agent-page header). The toolbar opens with the
// state-aware quick actions (QuickActionButtons) and then `leading` — the Test / Preview control — so
// the quick icons always sit immediately left of it; `quick={false}` leaves them to the caller (the
// comfortable Board card puts them on its preview line). `menuOnly` is the Agents list's trailing ⋯:
// no toolbar (the row renders its quick icons itself, left of its preview cell); Open ▸ Agent chat
// takes the reply. `contextAt` (menuOnly) opens the SAME items as a right-click menu at that point — a
// second, controlled root over the one items fragment, so the two menus can't drift.
export function WorkstreamActions({ row, hasWork = true, compact = false, leading, quick = true, tipSide, menuOnly = false, contextAt, onContextClose }: {
  row: Row; hasWork?: boolean; compact?: boolean; leading?: ReactNode; quick?: boolean; tipSide?: "top" | "bottom"; menuOnly?: boolean;
  contextAt?: { x: number; y: number } | null; onContextClose?: () => void;
}) {
  // Reopen the follow-up box on reload if a draft was left in progress, so nothing typed is lost.
  const [composing, setComposing] = useState(() => hasDraft(followUpDraftKey(row)));
  const [renaming, setRenaming] = useState(false);
  // The follow-up submit is optimistic — the box closes instantly while the launch (ensureWorktree +
  // upload + claude) runs for a few seconds. Show a spinner on the Follow up button meanwhile, so the
  // work isn't invisible.
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Wrap every action so it (a) surfaces errors — menu items are fire-and-forget, so a failed
  // promote/merge would otherwise vanish silently — as a failed-action notification (lib/notificationStore: the message, Copy,
  // Ask the orchestrator), never as text in the row, where it broke the Agents list's layout; the ⋯
  // keeps only a ✗ with the first line as its tooltip; and (b) tracks busy PER ACTION (keyed by its
  // label), so only the clicked item shows a spinner and is disabled — every other action, the card
  // link, the chat and the menu itself stay usable. A second click on the SAME action while it's
  // still running is a no-op (`isBusy` guards `run`); if the server itself refuses because the agent
  // is already running, that lands in `fail` as the usual error toast — no extra client-side rule.
  const [busyActions, setBusyActions] = useState<Set<string>>(() => new Set());
  const isBusy = (action: string) => busyActions.has(action);
  const fail = (action: string, e: unknown) => {
    setErr(e instanceof Error ? e.message : String(e));
    actionFailed({ action, title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }, e);
  };
  const run = (action: string, fn: () => Promise<unknown>) => async () => {
    if (busyActions.has(action)) return;
    setErr(null);
    setBusyActions((s) => new Set(s).add(action));
    try { await fn(); }
    catch (e) { fail(action, e); }
    finally { setBusyActions((s) => { const next = new Set(s); next.delete(action); return next; }); }
  };

  const isPr = Boolean(row.prNumber);
  const notified = Boolean(row.slackNotifiedAt);
  const bumpDue = shouldBump(row.slackNotifiedAt, row.slackLastBumpedAt, Date.now(), staleHours());
  const unreviewed = isPr && row.reviewStatus !== "approved";

  const moveTargets = row.worktreePath ? instanceChoices().filter((i) => i !== (row.instance ?? thisInstance())) : [];
  const mergeWhenGreenOn = Boolean(row.autoMergeEnabled || row.mergeWhenGreen);
  // The message Send message posts, as Slack pastes it (rich text, else plain).
  const copySlack = async () => {
    try { await writeSlackClipboard(row); }
    catch { await copyText(slackClipboard({ title: row.title, prNumber: row.prNumber ?? 0, prUrl: row.prUrl, previewUrl: row.previewUrl }, "notify").text, "Slack message"); }
  };
  const confirmMerge = async () => { if (await confirmDialog(mergeConfirm(row))) await run("Merge", () => merge(row))(); };

  // Icon-only in compact view; labelled otherwise. `icon` keeps every toolbar button a
  // consistent square so the row lines up regardless of which verbs are present.
  const icon = compact ? "icon" : "sm";
  const iconClass = compact ? "size-7" : undefined;
  const narrow = useNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);
  const trigger = (onClick?: () => void) => (
    <Button size={icon} className={iconClass} variant="ghost" aria-label="Actions" data-state-error={err ? "" : undefined}
      {...(onClick && { onClick, "aria-haspopup": "menu" as const, "aria-expanded": sheetOpen })}>
      {err && <X className="text-destructive size-3.5" />}
      {compact ? (!err && <MoreVertical className="size-4" />) : <>Actions <ChevronDown className="size-3.5" /></>}
    </Button>
  );
  const menu = workstreamMenu(row, { previewConfigured: previewConfigured(row.repo), moveTargets: moveTargets.length });
  const has = (id: MenuItemId) => Object.values(menu).some((ids) => ids.includes(id));
  const chatPath = detailPath(row);
  const openUrl = (url?: string) => url && window.open(url, "_blank", "noreferrer");
  const copy = (action: string, text: () => string | Promise<string>, label: string) => run(action, async () => { await copyText(await text(), label); });
  const items = (
    <>
      {/* Open ▸ — every place this workstream lives; Orchestrator only fills its composer, never sends. */}
      <Sub label="Open">
        {has("open.chat") && <Item icon={MessageSquare} onSelect={() => chatPath && navigate(`${chatPath}/chat`)}>Agent chat</Item>}
        {has("open.pr") && <Item icon={ExternalLink} onSelect={() => openUrl(row.prUrl)}>PR on GitHub</Item>}
        {has("open.preview") && <Item icon={Globe} onSelect={() => openUrl(row.previewUrl)}>PR preview</Item>}
        {has("open.ci") && <Item icon={CircleX} onSelect={() => openUrl(failingCiUrl(row))}>Failing CI run</Item>}
        <Item icon={Bot} onSelect={() => openOrchestrator(orchestratorAbout(row))}>Orchestrator</Item>
      </Sub>

      {/* Copy ▸ — a missing worktree is adopted first (Worktree path, CLI command). */}
      <Sub label="Copy">
        <Item icon={GitBranch} busy={isBusy("Copy branch")} onSelect={copy("Copy branch", () => row.branch, "branch")}>Branch name</Item>
        {has("copy.prLink") && <Item icon={Link} busy={isBusy("Copy PR link")} onSelect={copy("Copy PR link", () => row.prUrl ?? "", "PR link")}>PR link</Item>}
        {has("copy.prMarkdown") && <Item icon={Link} busy={isBusy("Copy PR markdown link")} onSelect={copy("Copy PR markdown link", () => prMarkdownLink(row), "PR markdown link")}>PR as markdown link</Item>}
        {has("copy.slack") && <Item icon={Send} busy={isBusy("Copy Slack message")} onSelect={run("Copy Slack message", copySlack)}>Slack message text</Item>}
        {has("copy.preview") && <Item icon={Globe} busy={isBusy("Copy preview URL")} onSelect={copy("Copy preview URL", () => row.previewUrl ?? "", "preview URL")}>Preview URL</Item>}
        <Item icon={FolderOpen} busy={isBusy("Copy worktree")} onSelect={copy("Copy worktree", async () => row.worktreePath ?? (await ensureWorktree(row)), "worktree path")}>Worktree path</Item>
        {has("copy.cli") && <Item icon={SquareTerminal} busy={isBusy("Copy CLI")} onSelect={copy("Copy CLI", () => cliCommand(row), "CLI command")}>CLI command</Item>}
      </Sub>

      {/* Merge ▸ — Merge when green is GitHub's auto-merge, or Orca's queue where the repo refuses it
          (store.autoMerge); off cancels whichever is active (store.disableAutoMerge). */}
      {menu.merge.length > 0 && (
        <Sub label="Merge">
          {has("merge.now") && <Item icon={GitMerge} busy={isBusy("Merge")} onSelect={() => void confirmMerge()}>Merge now{unreviewed ? " (unreviewed)" : ""}</Item>}
          {has("merge.whenGreen") && (
            <CheckItem icon={Zap} checked={mergeWhenGreenOn}
              onCheckedChange={mergeWhenGreenOn ? run("Disable merge when green", () => disableAutoMerge(row)) : run("Merge when green", () => autoMerge(row))}>
              Merge when green
            </CheckItem>
          )}
        </Sub>
      )}

      {/* PR ▸ — the open PR's verbs; for a local branch, Create PR (today's Promote). */}
      {menu.pr.length > 0 && (isPr ? (
        <Sub label="PR">
          {has("pr.markReady") && <Item icon={CheckCheck} busy={isBusy("Mark ready")} onSelect={run("Mark ready", () => markReady(row))}>Mark ready</Item>}
          {has("pr.moveToDraft") && <Item icon={GitPullRequestDraft} busy={isBusy("Move to draft")} onSelect={run("Move to draft", () => convertToDraft(row))}>Move to draft</Item>}
          {/* One agent verb: conflicts, CI and review in a single run (store.addressPr). */}
          {has("pr.address") && <Item icon={Wrench} busy={isBusy("Address PR")} onSelect={run("Address PR", () => addressPr(row))}>Address PR</Item>}
          {has("pr.addPreview") && <Item icon={Globe} busy={isBusy("Add preview")} onSelect={run("Add preview", () => addPreviewLabel(row))}>Add preview</Item>}
          {has("pr.previewPending") && <Item icon={Globe} disabled>Deploying preview…</Item>}
        </Sub>
      ) : has("pr.promote")
        ? <Sub label="PR"><Item icon={GitPullRequestArrow} disabled={!hasWork} busy={isBusy("Promote")} onSelect={run("Promote", () => promote(row))}>Promote</Item></Sub>
        : <PromoteSubmenu row={row} disabled={!hasWork} run={run} isBusy={isBusy} />)}

      {/* Agent ▸ — Stop keeps the worktree, its commits and the session (the chat's Stop). */}
      {menu.agent.length > 0 && (
        <Sub label="Agent">
          {has("agent.stop") && <Item icon={Square} busy={isBusy("Stop agent")} onSelect={run("Stop agent", () => stopAgent(row))}>Stop agent</Item>}
          {has("agent.resolveConflicts") && <Item icon={Wrench} busy={isBusy("Resolve conflicts")} onSelect={run("Resolve conflicts", () => resolveConflicts(row))}>Resolve conflicts</Item>}
          {/* Move the worktree to another instance (verbs.moveWorkstream). Not while its agent runs. */}
          {has("agent.move") && moveTargets.map((to) => {
            const moveItem = <Item icon={ArrowRightLeft} key={to} disabled={row.agentStatus === "running"} busy={isBusy(`Move to ${to}`)} onSelect={run(`Move to ${to}`, () => moveWorkstream(row, to))}>Move to {to}</Item>;
            return row.agentStatus === "running" ? <Tip key={to} label="Wait for the agent to finish first">{moveItem}</Tip> : moveItem;
          })}
        </Sub>
      )}

      {/* Slack ▸ — only once there is a PR to link */}
      {menu.slack.length > 0 && (
        <Sub label="Slack">
          <Item icon={Send} busy={isBusy("Slack message")} onSelect={run("Slack message", () => sendSlack(row, "notify"))}>Send message{notified ? " again" : ""}</Item>
          <Item icon={BellRing} disabled={!notified} busy={isBusy("Slack bump")} onSelect={run("Slack bump", () => sendSlack(row, "bump"))}>Send bump{bumpDue ? " (due)" : ""}</Item>
        </Sub>
      )}

      <Sep />
      {/* The user's own Verified marker (VerifiedButton): set, re-set at a new head, or clear. */}
      {canVerify(row) && verifiedState(row.verified, row.prHead, row.prNumber) !== "verified" && (
        <Item icon={ShieldCheck} onSelect={() => setVerified(row, true)}>{row.verified ? "Verify again (new commits)" : "Mark verified"}</Item>
      )}
      {canVerify(row) && row.verified && <Item icon={ShieldOff} onSelect={() => setVerified(row, false)}>Clear verified</Item>}
      {/* Rename — fix a broken/auto title. AI suggests a name (editable); a PR renames on GitHub. */}
      <Item icon={Pencil} onSelect={() => setRenaming(true)}>Rename…</Item>

      {/* Close/Discard — Close PR abandons an open PR (+cleanup); Discard only for pre-PR locals */}
      <Sep />
      {isPr ? (
        <Item icon={XCircle}
          className="text-destructive focus:text-destructive"
          busy={isBusy("Close PR")}
          onSelect={() => void (async () => {
            if (await confirmDialog({ title: `Close PR #${row.prNumber}?`, description: `Close "${row.title}" without a merge. This removes the worktree and the local branch.`, confirmLabel: "Close PR", destructive: true })) await run("Close PR", () => closePr(row))();
          })()}
        >
          Close PR
        </Item>
      ) : (
        <Item icon={Trash2}
          className="text-destructive focus:text-destructive"
          onSelect={() => void (async () => {
            if (await confirmDialog({ title: `Discard "${row.title}"?`, description: `This removes the worktree and the branch ${row.branch}. You cannot undo this.`, confirmLabel: "Discard", destructive: true })) await discardDraft(row);
          })()}
        >
          Discard
        </Item>
      )}
    </>
  );
  return (
    // `flex flex-col gap-2`, not `space-y-2`: a margin-based gap still reserves space for a
    // `display:none` sibling (the closed RenameDialog, or the TerminalDialog above this component),
    // which inflated this wrapper past the toolbar's own height and threw off the Actions cell's
    // vertical centering on every row. `gap` only spaces boxes the layout actually generates.
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {!menuOnly && quick && <QuickActionButtons row={row} hasWork={hasWork} tipSide={tipSide} />}
        {!menuOnly && leading}
        {!menuOnly && <Button size={icon} className={iconClass} variant="soft" disabled={submitting || row.agentStatus === "running"} onClick={() => setComposing((v) => !v)} aria-label="Follow up">
          {compact
            ? (submitting ? <Loader2 className="size-4 animate-spin" /> : <MessageSquarePlus className="size-3.5" />)
            : <>{submitting && <Loader2 className="size-4 animate-spin" />}Follow up</>}
        </Button>}
        {narrow ? (
          // A phone: the ⋯ opens the items as a bottom sheet — on a tap only, never a long-press.
          <>
            {err ? <Tip label={firstLine(err)}>{trigger(() => setSheetOpen(true))}</Tip> : trigger(() => setSheetOpen(true))}
            <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={row.title} slot="actions-sheet">
              <SheetMenu.Provider value={() => setSheetOpen(false)}>
                <div role="menu" aria-label={`Actions for ${row.title}`} className="-mx-2 -my-2 flex flex-col">{items}</div>
              </SheetMenu.Provider>
            </BottomSheet>
          </>
        ) : (
          <DropdownMenu>
            {err ? <Tip label={firstLine(err)}><DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger></Tip> : <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>}
            <DropdownMenuContent align={menuOnly ? "end" : "start"} className="min-w-[12rem]">
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {menuOnly && contextAt && !narrow && createPortal(
          // Right-click: the same items, anchored to a zero-size trigger at the pointer. Radix gives it
          // the menu's keyboard handling (arrows, Enter, Esc) and closes it on an outside click. In
          // <body>, because the page column has `contain: layout paint`, which would place a `fixed`
          // anchor against the column instead of the window.
          <DropdownMenu key={`${contextAt.x},${contextAt.y}`} open onOpenChange={(o) => { if (!o) onContextClose?.(); }}>
            <DropdownMenuTrigger asChild>
              <span data-slot="context-anchor" aria-hidden="true" tabIndex={-1} style={{ position: "fixed", left: contextAt.x, top: contextAt.y, width: 0, height: 0 }} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={0} data-slot="row-context-menu" aria-label={`Actions for ${row.title}`} className="min-w-[12rem]"
              onCloseAutoFocus={(e) => e.preventDefault()}>
              {items}
            </DropdownMenuContent>
          </DropdownMenu>,
          document.body,
        )}
      </div>
      <RenameDialog row={row} open={renaming} onClose={() => setRenaming(false)} />
      {composing && (
        <FollowUpComposer
          row={row}
          onClose={() => setComposing(false)}
          // Launch failed: reopen with the (still-persisted) prompt and surface why.
          onFail={(msg) => { fail("Follow up", new Error(msg)); setComposing(true); }}
          onSubmitting={setSubmitting}
        />
      )}
    </div>
  );
}

// Rename a card. The name field is editable but "Suggest" fills it with an AI-generated title — the
// primary path when an auto-title came out broken. Saving edits the GitHub PR title for a PR (its title
// IS the card's) and always records it in enrichment. Native <dialog> for the backdrop/ESC/focus-trap.
function RenameDialog({ row, open, onClose }: { row: Row; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState<null | "suggest" | "save">(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setTitle(row.title); setErr(null); d.showModal(); } // seed with the current title each open
    else if (!open && d.open) d.close();
  }, [open, row.title]);

  const suggest = async () => {
    setBusy("suggest"); setErr(null);
    try { setTitle(await suggestTitle(row)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const save = async () => {
    const next = title.trim();
    if (!next) return;
    setBusy("save"); setErr(null);
    try { await rename(row, next); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }} // backdrop click → close
      className="bg-card text-foreground m-auto w-[28rem] max-w-[90vw] rounded-lg border p-0 shadow-modal backdrop:bg-black/50"
    >
      <form className="flex flex-col gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="text-sm font-medium">Rename {row.prNumber ? `PR #${row.prNumber}` : "card"}</div>
        <Input
          autoFocus
          aria-label="Card title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Card title"
          className="bg-background h-9 px-3"
        />
        {row.prNumber ? <p className="text-muted-foreground text-xs">Updates the GitHub PR title.</p> : null}
        {err && <p className="text-destructive text-xs break-words">{err}</p>}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" size="sm" variant="soft" disabled={Boolean(busy)} onClick={suggest}>
            {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-3.5" />} Suggest
          </Button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={Boolean(busy) || !title.trim()}>
              {busy === "save" && <Loader2 className="size-4 animate-spin" />} Save
            </Button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

// PR ▸ for a local branch (today's Promote): create the PR ready or as a draft and toggle the repo's configured PR labels
// (config `prLabels`; entries with `default: true` start checked). Repos with none show no toggles.
function PromoteSubmenu({ row, disabled, run, isBusy }: { row: Row; disabled?: boolean; run: (action: string, fn: () => Promise<unknown>) => () => void; isBusy: (action: string) => boolean }) {
  const prLabels = useRepos().find((r) => r.name === row.repo)?.prLabels ?? [];
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(prLabels.map((l) => [l.name, l.default ?? false])));
  const labels = prLabels.filter((l) => checked[l.name]).map((l) => l.name);
  return (
    <Sub label="PR" disabled={disabled}>
      {prLabels.length > 0 && <Label>Labels</Label>}
      {prLabels.map((l) => (
        <CheckItem icon={Tag} key={l.name} checked={checked[l.name] ?? false}
          onCheckedChange={(c) => setChecked((s) => ({ ...s, [l.name]: Boolean(c) }))} onSelect={(e) => e.preventDefault()}>
          {l.name}
        </CheckItem>
      ))}
      {prLabels.length > 0 && <Sep />}
      <Item icon={GitPullRequestArrow} busy={isBusy("Create PR")} onSelect={run("Create PR", () => promote(row, { draft: false, labels }))}>Create PR</Item>
      <Item icon={GitPullRequestDraft} busy={isBusy("Create draft PR")} onSelect={run("Create draft PR", () => promote(row, { draft: true, labels }))}>Create draft PR</Item>
    </Sub>
  );
}

export function FollowUpComposer(
  { row, onClose, onFail, onSubmitting }: { row: Row; onClose: () => void; onFail: (msg: string) => void; onSubmitting: (busy: boolean) => void },
) {
  const key = followUpDraftKey(row);
  // The composer's picker IS the card's pin — one persisted choice, surfaced here and on the card
  // header. Changing it re-pins the card, so every later action (Address PR, …) runs on it too; the
  // send below resolves the same pin, so no local mirror state to drift.
  return (
    <ChatComposer
      autoFocus
      optimistic
      persistKey={key}
      repo={row.repo}
      // ↑/↓ recall past follow-ups sent on this branch — resend the last one after an error without
      // retyping. Kept in enrichment (row.followUps, oldest first) until the branch ends.
      history={[...new Set([...(row.followUps ?? [])].reverse())]}
      placeholder="Continue this work…"
      leading={
        <div className="flex min-w-0 w-full items-center overflow-hidden">
          <ModelPicker label="Model" value={modelFor(row)} ran={row.agentMeta?.model} onChange={(m) => setCardModel(row, m)} className="max-w-full" />
        </div>
      }
      // Optimistic submit: close the box the instant you send (launching the agent takes a few
      // seconds — ensureWorktree + upload). The draft stays persisted, so a failed launch reopens
      // it with the same prompt; a success drops it. `onSubmitting` drives the Follow up button's
      // spinner for the duration, so the in-flight launch isn't invisible after the box closes.
      onSubmit={async (instruction, images) => {
        onClose();
        onSubmitting(true);
        // followUp records the sent prompt in enrichment before it can fail, so the local draft is
        // safe to drop as soon as the send is handed off (a failed launch reopens the box from it).
        try { await followUp(row, instruction, images); clearDraft(key); }
        catch (e) { onFail(e instanceof Error ? e.message : String(e)); }
        finally { onSubmitting(false); }
      }}
      onCancel={onClose}
    />
  );
}

/** The workstream's state-aware quick actions (workstream.quickActions — the ONE mapping the header,
 *  the Board card and the Agents rows share) as icon-only ghost buttons, each with its tooltip: the
 *  notification quick actions' style (size-7, first in the foreground colour, the rest muted; spinner
 *  → ✓/✗; a failure is an action-failed notification). Each runs the existing store verb its ⋯ menu
 *  item runs. Busy is scoped to the one button that was clicked (ActionButton's own loading state,
 *  which also blocks a double-click) — every other action, the card link, the chat and the menu stay
 *  usable while it runs. A disabled one says why in its tooltip. Below md only the first two show.
 *  `peek` reads the review digest only if it is already cached (an Agents row: never one fetch per
 *  row); without it, the actions are decided on what the row itself knows. Clicks never reach an
 *  enclosing row. */
export function QuickActionButtons({ row, hasWork = true, peek = false, tipSide = "top", className }: {
  row: Row; hasWork?: boolean; peek?: boolean; tipSide?: "top" | "bottom"; className?: string;
}) {
  const repoInfo = useRepos().find((r) => r.name === row.repo);
  const fetched = useReviewDigest(row.repo, peek ? undefined : row.prNumber, reviewSig(row));
  const cached = useCachedReviewDigest(row.repo, peek ? row.prNumber : undefined);
  const digest = peek ? cached : fetched;
  const actions = quickActions(row, {
    hasWork, reviewProblems: digest && reviewProblems(digest), slackChannel: Boolean(slackChannel(row.repo)),
  });
  if (!actions.length) return null;
  const defaultLabels = (repoInfo?.prLabels ?? []).filter((l) => l.default).map((l) => l.name);
  const verb = (id: QuickActionId, slackKind?: "notify" | "bump"): (() => Promise<unknown>) => {
    switch (id) {
      case "createPr": return () => (row.hasRemote ? promote(row, { draft: false, labels: defaultLabels }) : promote(row));
      case "markReady": return () => markReady(row);
      case "addressPr": return () => addressPr(row);
      case "slack": return () => sendSlack(row, slackKind ?? "notify");
      case "merge": return () => merge(row);
      case "autoMerge": return () => autoMerge(row);
      case "disableAutoMerge": return () => disableAutoMerge(row);
    }
  };
  return (
    <div data-slot="quick-actions" className={cn("flex items-center gap-1", className)} onClick={(e) => e.stopPropagation()}>
      {actions.map((a, i) => {
        const Icon = QUICK_ICONS[a.id];
        const run = verb(a.id, a.slackKind);
        return (
          <Tip key={a.id} label={a.disabled ?? a.tip ?? a.label} side={tipSide} className={i >= 2 ? "max-md:hidden" : undefined}>
            <span data-quick-action={a.id} className="inline-flex">
              <ActionButton size="icon" variant="ghost" label={a.label} disabled={Boolean(a.disabled)}
                className={cn("size-7", i === 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                confirm={a.id === "merge" ? mergeConfirm(row) : undefined}
                failure={{ action: a.label, title: row.title, repo: row.repo, branch: row.branch, prNumber: row.prNumber }}
                onRun={run}>
                {/* Auto-merge already on: a filled bolt, so the state reads at a glance. */}
                <Icon className={cn("size-3.5", a.on && "fill-current text-purple-700 dark:text-purple-400")} />
              </ActionButton>
            </span>
          </Tip>
        );
      })}
    </div>
  );
}
