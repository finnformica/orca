// Settings > Integrations (docs/research/integrations.md §6.1): first the people — each a global
// person with identities on any adapter, their level and the pending pairing codes — then a card per
// integration row, an accordion item: its header has the name (edited in place), the health, the
// enabled switch (connect / disconnect) and the menu; open, a Test, the policy and its links
// with their level and repos — the subscriptions, and the dead deliveries with Retry. Generic over adapter kinds: the kinds, their
// labels and their Connect fields come from the registry (`overview.kinds`), so a new adapter's
// card and form appear with no change here. The decisions are pure in shared/integrationSettings.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bell, MoreHorizontal, Plug, Plus, RotateCw, Trash2, X } from "lucide-react";
import { api } from "../api";
import { BrandIcon } from "@/components/BrandIcon";
import { poll } from "@/lib/poll";
import { notifyLocal } from "@/lib/notificationStore";
import { instanceChoices, thisInstance, useRepos } from "../store";
import { ago } from "../workstream";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tip } from "@/components/ui/tip";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, Pill, SectionTitle, StatusDot, VCard } from "@/components/console";
import {
  SUBSCRIPTION_PRESETS, connectOriginProblem, deadTargetLabel, filterText, healthLine, healthTone, identityLabel, identityProblem, instanceText, newPersonId as personId, integrationProblem, linkProblem, parseFilter, targetLabel,
  type IntegrationCard, type InstanceOption, type IntegrationsOverview, type LinkRow, type Pairing, type PersonRow, type AgentOption, agentLabel, linkAgentValue,
} from "../../../shared/integrationSettings";
import { needsNote, serverKeyRefusal } from "../../../shared/serverKeys";
import { ACCESS_LABEL, ACCESS_VALUES, AUTO_INSTANCE, apiKeyProblem, CATCH_ALL, EVENTS_LABEL, EVENTS_VALUES, LEVEL_LABEL, LINK_LEVELS as LEVELS, STORED_SECRET_PREFIX, effectiveNotify, isAutomatic, repoScoped, storedSecretName, type AdapterMeta, type EventsMode, type LinkLevel } from "../../../shared/integrations";

type Overview = IntegrationsOverview;
// Friendly names (Notify, Viewer, Editor, Admin); the stored values stay notify / ask / work / admin.
const LINK_LEVELS: { value: LinkLevel; label: string }[] = LEVELS.map((value) => ({ value, label: LEVEL_LABEL[value] }));
// Pairing approval is unchanged: it takes up to "work" (POST /api/integrations/pairing/approve). Set Admin on the person after.
const PAIRING_LEVELS = LINK_LEVELS.filter((l) => l.value !== "admin");
// A link's two switches, on the row and in the link dialog. Both on by default.
const NOTIFY_SWITCHES = [
  { key: "notifyMe", label: "Notify me", slot: "link-notify-me", hint: "Each message shows in the bell, the Inbox and the chat. Turn it off for a busy place." },
  { key: "notifyAgent", label: "Notify agent", slot: "link-notify-agent", hint: "Each message wakes the link's agent (the Agent menu; the Assistant by default). A paired person keeps their level; an unknown sender is read-only: the agent tells you and does not reply." },
] as const;
const LEVEL_TONE = { notify: "default", ask: "blue", work: "green", admin: "purple" } as const;
// The account policy (docs/integrations/POLICY.md), one line each in the select.
const ACCESS_HINT = { read: "Search, read and list only", "read-write": "Also post, send, reply and delete" } as const;
const EVENTS_HINT = { trigger: "Show it and wake an agent", record: "Show it in the Inbox; wake no agent", off: "Record nothing" } as const;
// The page's own copy of server/env.ts ORCA_SECRETS (the server checks again): enough to warn early.
const STRIPPED = ["SLACK_TOKEN"] as const;


/** Run one write; a failure is the one action-failed notification, never text in the row. */
async function act(label: string, path: string, body: Record<string, unknown>, done: () => void): Promise<Record<string, unknown> | undefined> {
  try { const r = await api.integrationPost(path, body); done(); return r; }
  catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    notifyLocal({ kind: "action_failed", repo: "", title: "Integrations", label: `${label} failed`, body: error, copy: `Action: ${label}\nError:\n${error}`, ask: `Integrations: ${label} failed: ${error}. Please investigate and fix.` });
    return undefined;
  }
}

/** A destructive click asks first, in shadcn's AlertDialog: `ask(title, body, run)` and render `node`. */
function useConfirm(action = "Remove"): [(title: string, body: string, run: () => void) => void, ReactNode] {
  const [q, setQ] = useState<{ title: string; body: string; run: () => void } | null>(null);
  const node = (
    <AlertDialog open={!!q} onOpenChange={(o) => { if (!o) setQ(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{q?.title}</AlertDialogTitle>
          <AlertDialogDescription>{q?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => { q?.run(); setQ(null); }}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return [(title, body, run) => setQ({ title, body, run }), node];
}

export function IntegrationsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string>();
  const load = () => api.integrations().then((d) => { setData(d); setError(undefined); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => poll(load, 15_000), []);
  useEffect(() => oauthReturn(), []);
  const reload = () => void load();
  // Which integration cards are open: collapsed at first, kept while the page is open (a poll keeps it).
  const [expanded, setExpanded] = useState<string[]>([]);
  return (
    <div className="max-w-4xl space-y-6" data-slot="integrations-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        {data && <ConnectButton kinds={data.kinds} options={data.instanceOptions ?? []} onSaved={reload} />}
      </div>
      {error && !data && <VCard><Empty>{error}</Empty></VCard>}
      {!data && !error && <VCard><Empty>Loading…</Empty></VCard>}
      {data && (
        <>
          <PeopleCard data={data} onChange={reload} />
          {data.integrations.length === 0
            ? <div data-slot="integrations-list"><VCard slot="integrations-empty"><Empty icon={<Plug className="size-5" />}>No integrations yet. Connect one of: {data.kinds.map((k) => k.label).join(", ")}.</Empty></VCard></div>
            : <Accordion type="multiple" value={expanded} onValueChange={setExpanded} className="space-y-3" data-slot="integrations-list">
                {data.integrations.map((c) => <IntegrationCardView key={c.id} card={c} data={data} onChange={reload} />)}
              </Accordion>}
          <SubscriptionsCard data={data} onChange={reload} />
          <DeadCard data={data} onChange={reload} />
        </>
      )}
    </div>
  );
}

/** Back from Google (`/integrations?oauth=added|connected|failed&id=…&account=…&detail=…`): a failure
 *  is the one action-failed notification; success shows on the card (a new account's card appears).
 *  The query is then taken off the URL. */
function oauthReturn(): void {
  const q = new URLSearchParams(window.location.search);
  const result = q.get("oauth");
  if (!result) return;
  if (result === "failed") {
    const error = q.get("detail") || "Google sign-in failed";
    const label = q.get("id") ? `Reconnect ${q.get("id")} with Google` : "Sign in with Google";
    notifyLocal({ kind: "action_failed", repo: "", title: "Integrations", label: `${label} failed`, body: error, copy: `Action: ${label}\nError:\n${error}`, ask: `Integrations: ${label} failed: ${error}. Please investigate and fix.` });
  }
  for (const k of ["oauth", "id", "account", "detail"]) q.delete(k);
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
}

/** The scopes Google granted, in words (server/integrations/adapters/gmail.ts scopeWords for the browser). */
const grantedWords = (scopes: string[] = []): string =>
  !scopes.some((x) => x.endsWith("/gmail.readonly")) ? "no Gmail scope" : scopes.some((x) => x.endsWith("/gmail.send")) ? "read + send" : "read only";

/** The card's sign-in button text: the kind's label (Sign in with Google) until an account is
 *  connected, then Reconnect; a missing send scope (access switched to read-write) asks to allow sending. */
export function oauthButtonLabel(label: string, o: IntegrationCard["oauth"]): string {
  if (!o?.account) return label;
  if (o.missing?.some((x) => x.endsWith("/gmail.send"))) return "Reconnect to allow sending";
  return `Reconnect ${label.replace(/^(Connect|Sign in) /, "")}`;
}

/** The one line a Connect dialog or a card shows instead of the sign-in button: the OAuth client is
 *  not set up on this server (with the setup doc), or the page is not on Orca's https address. */
function OAuthBlocked({ setup, origin, docs }: { setup?: string; origin?: string; docs?: string }) {
  if (setup) return (
    <div data-slot="oauth-setup" className="text-geist-amber break-words text-xs">
      {setup} {docs && <a href={docs} target="_blank" rel="noreferrer" className="underline underline-offset-2">Read the setup guide</a>}
    </div>
  );
  return origin ? <div data-slot="oauth-origin" className="text-geist-amber break-words text-xs">{origin}</div> : null;
}

/** Ask the bridge for Google's consent URL and go there: no `id` adds a new account, an `id` reconnects that row. */
async function startOAuth(label: string, id?: string): Promise<boolean> {
  const r = await act(label, "oauth/google/start", { ...(id ? { id } : {}), origin: window.location.origin }, () => {});
  if (r && typeof r.url === "string") { window.location.assign(r.url); return true; }
  return false;
}

/** An OAuth kind's row on the card: the account it connected, or why it needs you, and its Connect /
 *  Reconnect / Disconnect. Connect asks the bridge for Google's consent URL and goes there. */
function OAuthRow({ card: c, meta, onChange }: { card: IntegrationCard; meta: NonNullable<AdapterMeta["oauth"]>; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [ask, confirmNode] = useConfirm("Disconnect");
  const o = c.oauth;
  const connected = !!o?.account;
  const label = oauthButtonLabel(meta.label, o);
  // Google redirects only to an https domain: from a plain-http or localhost page, say where to go.
  const fixed = (typeof c.config.redirectOrigin === "string" && c.config.redirectOrigin) || meta.fixedOrigin;
  const originProblem = fixed ? undefined : connectOriginProblem(window.location.origin);
  const go = async () => { setBusy(true); if (!(await startOAuth(`${label} (${c.name})`, c.id))) setBusy(false); };
  return (
    <div data-slot="integration-oauth" className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="break-words">
          {connected
            ? <>Signed in as <span className="font-medium">{o!.account}</span> · {grantedWords(o!.scopes)}</>
            : "Not connected. Sign in with Google to connect this account again."}
        </div>
        <div className="mt-0.5"><OAuthBlocked setup={meta.setup} origin={originProblem} docs={meta.docs} /></div>
        {o?.reconnect && <div data-slot="oauth-reconnect" className="text-geist-red mt-0.5 break-words text-xs">{o.reconnect}</div>}
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">
        {connected && <Button variant="ghost" size="sm" className="max-sm:h-10" onClick={() => ask(`Disconnect ${c.name}?`, "Orca revokes its access at Google and deletes the stored refresh token. The integration, its links and its events stay.", () => void act(`Disconnect ${c.name}`, "oauth/google/disconnect", { id: c.id }, onChange))}>Disconnect</Button>}
        <Button size="sm" variant={connected && !o?.reconnect && !o?.missing?.length ? "secondary" : "default"} disabled={busy || !!originProblem || !!meta.setup} onClick={() => void go()} data-slot="oauth-connect" className="max-sm:h-10 max-sm:flex-1">
          {label}
        </Button>
      </div>
      {confirmNode}
    </div>
  );
}

// ── one integration ─────────────────────────────────────────────────────────────────────────────

function IntegrationCardView({ card: c, data, onChange }: { card: IntegrationCard; data: Overview; onChange: () => void }) {
  const meta = data.kinds.find((k) => k.kind === c.kind);
  // The catch-all link first: it is the integration's one link to every channel and DM.
  const links = data.links.filter((l) => l.integrationId === c.id).sort((a, b) => Number(b.externalId === CATCH_ALL) - Number(a.externalId === CATCH_ALL));
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; detail?: string }>({});
  const [linkOpen, setLinkOpen] = useState<LinkRow | "new" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const runTest = async () => {
    setTest({ busy: true });
    const r = await act(`Test ${c.name}`, "test", { id: c.id }, onChange);
    setTest(r ? { ok: r.ok === true, detail: typeof r.detail === "string" ? r.detail : undefined } : {});
  };
  const tone = healthTone(c);
  const [ask, confirmNode] = useConfirm();
  const options = data.instanceOptions ?? [];
  const health = healthLine(c, Date.now(), options);
  return (
    // The header is the accordion's trigger: a click on it opens the config, links and settings.
    // The name, the switch and the menu sit beside the trigger (an input can't be inside a button),
    // and a click on the row's empty space toggles too.
    <AccordionItem value={c.id} data-slot="integration-card" className="bg-card overflow-hidden rounded-lg border last:border-b">
      <div data-slot="card-header" className="hover:bg-accent/40 flex min-h-12 cursor-pointer items-center gap-2 px-4 py-2"
        onClick={(e) => { if (e.target === e.currentTarget || !(e.target as HTMLElement).closest("button, input, a, [role=switch], [role=menuitem]")) (e.currentTarget.querySelector<HTMLElement>('[data-slot="accordion-trigger"]'))?.click(); }}>
        <BrandIcon kind={c.kind} />
        <InlineName card={c} onSaved={onChange} />
        <div className="min-w-0 flex-1">
          <AccordionTrigger className="min-h-8 min-w-0 gap-2 py-0 font-normal hover:no-underline" aria-label={`${c.name} details`}>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <StatusDot tone={tone} />
              <span data-slot="integration-health-summary" className="text-muted-foreground truncate text-xs max-sm:hidden">{health}</span>
            </span>
          </AccordionTrigger>
        </div>
        <Switch aria-label={`${c.name} connected`} checked={c.enabled} onCheckedChange={(on) => void act(on ? `Connect ${c.name}` : `Disconnect ${c.name}`, "enabled", { id: c.id, on }, onChange)} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`${c.name} actions`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLinkOpen("new")}>Add {meta?.place ?? "link"}</DropdownMenuItem>
            <DropdownMenuItem className="text-geist-red" onSelect={() => ask(`Remove ${c.name}?`, "Its links and the subscriptions that post to them go too. Past events stay.", () => void act(`Remove ${c.name}`, "remove", { id: c.id }, onChange))}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AccordionContent className="divide-y border-t p-0">
        <div className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            {/* The header shows the health from sm up; on a phone it shows here, in full. */}
            <div data-slot="integration-health" className="break-words sm:hidden">{health}</div>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs max-sm:mt-0.5">
              {c.secretRef
                ? <span data-slot="secret-status"><span className="font-mono">{c.secretRef}</span> · {c.secretSet === undefined ? "not checked yet" : c.secretSet ? "set" : "not set"}</span>
                : !meta?.oauth && <span>no secret</span>}
              {c.running && <span>· running on this bridge</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:shrink-0">
            {test.ok !== undefined && <span data-slot="integration-test-result" className={test.ok ? "text-geist-green text-xs" : "text-geist-red text-xs"}>{test.ok ? "OK" : "Failed"}{test.detail ? ` · ${test.detail}` : ""}</span>}
            <Button variant="secondary" size="sm" disabled={test.busy} onClick={() => void runTest()} className="max-sm:h-10 max-sm:flex-1">Test</Button>
          </div>
        </div>
        <PolicyRow card={c} onChange={onChange} />
        {meta?.oauth && <OAuthRow card={c} meta={meta.oauth} onChange={onChange} />}
        {links.length === 0
          ? <div className="text-muted-foreground flex items-center justify-between gap-2 px-4 py-3 text-xs">No {meta?.place ?? "link"}s linked. Orca listens only where a link says so.
              <Button variant="ghost" size="sm" onClick={() => setLinkOpen("new")}><Plus />Add</Button></div>
          : <ul data-slot="integration-links" className="divide-y">{links.map((l) => <LinkRowView key={l.id} link={l} events={c.events} agents={data.agents} onEdit={() => setLinkOpen(l)} onChange={onChange} />)}</ul>}
      </AccordionContent>
      {linkOpen && <LinkDialog integration={c} meta={meta} link={linkOpen === "new" ? undefined : linkOpen} onClose={() => setLinkOpen(null)} onSaved={onChange} />}
      {editOpen && <IntegrationDialog kinds={data.kinds} options={options} existing={c} onClose={() => setEditOpen(false)} onSaved={onChange} />}
      {confirmNode}
    </AccordionItem>
  );
}

/** The card's name, edited in place (a Gmail account is named by its address at sign-in): a click
 *  edits, Enter or a blur saves, Escape cancels. Only the name changes: the save carries the row's
 *  other fields as they are. An empty name puts the old one back. */
function InlineName({ card: c, onSaved }: { card: IntegrationCard; onSaved: () => void }) {
  const [name, setName] = useState(c.name);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  // A poll brings a new name (another tab renamed it): show it unless you are typing.
  useEffect(() => { if (!editing) setName(c.name); }, [c.name, editing]);
  const save = async () => {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; setName(c.name); return; }
    const next = name.trim();
    if (!next || next === c.name) { setName(c.name); return; }
    const r = await act(`Rename ${c.name}`, "save", { id: c.id, kind: c.kind, name: next, instance: c.instance, secretRef: c.secretRef ?? "", config: c.config, enabled: c.enabled }, onSaved);
    if (!r) setName(c.name);
  };
  return (
    <Input data-slot="integration-rename" aria-label={`Rename ${c.name}`} value={name} spellCheck={false}
      onFocus={() => setEditing(true)} onChange={(e) => setName(e.target.value)} onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); cancelled.current = true; e.currentTarget.blur(); }
      }}
      className="hover:border-input field-sizing-content h-7 w-auto max-w-[min(20rem,45vw)] min-w-12 shrink-0 truncate border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none md:text-sm dark:bg-transparent" />
  );
}

/** The account's Access and Events (docs/integrations/POLICY.md). The core reads them per call, so a
 *  change applies at once. Events narrow every link's switches; a link never widens them. */
function PolicyRow({ card: c, onChange }: { card: IntegrationCard; onChange: () => void }) {
  const set = (key: "access" | "events", value: string, label: string) => void act(`Set ${label} for ${c.name}`, "policy", { id: c.id, [key]: value }, onChange);
  return (
    <div data-slot="integration-policy" className="flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-6">
      <div data-slot="integration-access" className="flex items-center gap-2">
        <Label htmlFor={`access-${c.id}`} className="text-muted-foreground w-14 text-xs font-normal sm:w-auto">Access</Label>
        <Select value={c.access} onValueChange={(v) => set("access", v, "access")}>
          <SelectTrigger id={`access-${c.id}`} size="sm" aria-label={`${c.name} access`} className="w-40 max-sm:h-10 max-sm:flex-1"><SelectValue>{ACCESS_LABEL[c.access]}</SelectValue></SelectTrigger>
          <SelectContent>{ACCESS_VALUES.map((v) => (
            <SelectItem key={v} value={v}><span className="flex flex-col"><span>{ACCESS_LABEL[v]}</span><span className="text-muted-foreground text-xs">{ACCESS_HINT[v]}</span></span></SelectItem>
          ))}</SelectContent>
        </Select>
      </div>
      <div data-slot="integration-events" className="flex items-center gap-2">
        <Label htmlFor={`events-${c.id}`} className="text-muted-foreground w-14 text-xs font-normal sm:w-auto">Events</Label>
        <Select value={c.events} onValueChange={(v) => set("events", v, "events")}>
          <SelectTrigger id={`events-${c.id}`} size="sm" aria-label={`${c.name} events`} className="w-40 max-sm:h-10 max-sm:flex-1"><SelectValue>{EVENTS_LABEL[c.events]}</SelectValue></SelectTrigger>
          <SelectContent>{EVENTS_VALUES.map((v) => (
            <SelectItem key={v} value={v}><span className="flex flex-col"><span>{EVENTS_LABEL[v]}</span><span className="text-muted-foreground text-xs">{EVENTS_HINT[v]}</span></span></SelectItem>
          ))}</SelectContent>
        </Select>
      </div>
    </div>
  );
}

function LinkRowView({ link: l, events, agents, onEdit, onChange }: { link: LinkRow; events: EventsMode; agents?: AgentOption[]; onEdit: () => void; onChange: () => void }) {
  // The account's events mode can turn a switch off for every link (never on).
  const allowed = effectiveNotify({ me: true, agent: true }, events);
  const [test, setTest] = useState<{ busy?: boolean; state?: string; error?: string }>({});
  const run = async () => {
    setTest({ busy: true });
    const r = await act(`Test link ${l.label ?? l.externalId}`, "links/test", { id: l.id }, onChange);
    setTest(r ? { state: String(r.state), ...(typeof r.error === "string" ? { error: r.error } : {}) } : {});
  };
  const [ask, confirmNode] = useConfirm();
  const name = l.label ?? l.externalId;
  const setSwitch = (key: "notifyMe" | "notifyAgent", on: boolean) =>
    void act(`${on ? "Turn on" : "Turn off"} ${key === "notifyMe" ? "Notify me" : "Notify agent"} for ${name}`, "links/save", { ...l, [key]: on }, onChange);
  return (
    <li data-slot="integration-link" className="flex flex-col gap-2 px-4 py-3 text-sm md:flex-row md:items-center md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{l.label ?? (l.externalId === CATCH_ALL ? "All channels and DMs" : l.externalId)}</span>
          {l.label && l.externalId !== CATCH_ALL && <span className="text-muted-foreground font-mono text-xs">{l.externalId}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Pill tone={LEVEL_TONE[l.level]} slot="link-level">{LINK_LEVELS.find((x) => x.value === l.level)?.label}</Pill>
          {repoScoped(l.level) && l.repos.map((r) => <Pill key={r}>{r}</Pill>)}
          {l.requireMention && <Pill>@mention</Pill>}
        </div>
        {l.externalId === CATCH_ALL && <div data-slot="link-catch-all" className="text-muted-foreground mt-1 text-xs">Every channel, thread and DM the bot can see. Orca answers where a message came from, and posts to any channel with <span className="font-mono">orca post --link {l.id} --channel &lt;id&gt;</span>.</div>}
        {test.state && <div data-slot="link-test-result" className={test.state === "sent" ? "text-geist-green mt-1 text-xs" : test.state === "pending" ? "text-muted-foreground mt-1 text-xs" : "text-geist-red mt-1 text-xs"}>
          {test.state === "sent" ? "Test message sent" : test.state === "pending" ? "Test queued — not sent yet" : `Test ${test.state}${test.error ? `: ${test.error}` : ""}`}
        </div>}
      </div>
      <div className="flex items-center gap-1">
        {/* The agent that takes this link's messages (§7.7). Only with a server that has named agents. */}
        {agents && agents.length > 0 && (
          <div data-slot="link-agent" className="mr-2 flex items-center gap-2">
            <Label htmlFor={`link-agent-${l.id}`} className="text-muted-foreground text-xs font-normal">Agent</Label>
            <Select value={linkAgentValue(l)} onValueChange={(v) => void act(`Send ${name} to the ${agentLabel(v, agents)}`, "links/save", { ...l, agent: v === "assistant" ? "" : v }, onChange)}>
              <SelectTrigger id={`link-agent-${l.id}`} size="sm" aria-label={`Agent for ${name}`} className="w-36 max-sm:h-10"><SelectValue>{agentLabel(linkAgentValue(l), agents)}</SelectValue></SelectTrigger>
              <SelectContent>{agents.map((a) => <SelectItem key={a.name} value={a.name}>{a.displayName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        <div data-slot="link-switches" className="mr-2 flex items-center gap-4 max-md:flex-1">
          {NOTIFY_SWITCHES.map(({ key, label, slot }) => (
            <div key={key} data-slot={slot} className="flex items-center gap-2">
              <Label htmlFor={`${slot}-${l.id}`} className="text-muted-foreground text-xs font-normal">{label}</Label>
              {(() => {
                const on = allowed[key === "notifyMe" ? "me" : "agent"];
                const sw = <Switch id={`${slot}-${l.id}`} checked={l[key] !== false && on} disabled={!on}
                  onCheckedChange={(v) => setSwitch(key, v)} aria-label={`${label} for ${name}`} />;
                return on ? sw : <Tip label={`Off for every link: the account's Events is "${EVENTS_LABEL[events]}"`}>{sw}</Tip>;
              })()}
            </div>
          ))}
        </div>
        {l.externalId !== CATCH_ALL && <Button variant="secondary" size="sm" disabled={test.busy} onClick={() => void run()} className="max-md:h-10 max-md:flex-1">Test</Button>}
        <Button variant="ghost" size="sm" onClick={onEdit} className="max-md:h-10">Edit</Button>
        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10 size-8 max-md:size-10" aria-label={`Remove ${l.label ?? l.externalId}`}
          onClick={() => ask(`Remove ${l.label ?? l.externalId}?`, "Orca stops listening and posting there. Its subscriptions go too.", () => void act("Remove link", "links/remove", { id: l.id }, onChange))}><Trash2 /></Button>
      </div>
      {confirmNode}
    </li>
  );
}

// ── forms ────────────────────────────────────────────────────────────────────────────────────────

const Field = ({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) => (
  <div className="space-y-1.5">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
  </div>
);

function FormDialog({ title, description, problem, busy, onSubmit, onClose, children }: { title: string; description?: ReactNode; problem?: string; busy?: boolean; onSubmit: () => void; onClose: () => void; children: ReactNode }) {
  const [tried, setTried] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!problem) onSubmit(); }}>
          {children}
          {tried && problem && <p role="alert" className="text-geist-red text-xs">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A switch's value: the stored "true" / "false", else the adapter's default for the key. */
const switchOn = (v: string | undefined, dflt: boolean): boolean => (v === undefined || v === "" ? dflt : v === "true");

function ConnectButton({ kinds, options, onSaved }: { kinds: AdapterMeta[]; options: InstanceOption[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-slot="integration-connect"><Plus />Connect</Button>
      {open && <IntegrationDialog kinds={kinds} options={options} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

/** Connect for an OAuth kind (Gmail): ONE sign-in button and nothing to type. The OAuth client is the
 *  server's; each sign-in adds one account, named by its address. When the client is not set up on
 *  this server, or the page is not on Orca's https address, one line says so instead. */
function OAuthConnect({ meta }: { meta: AdapterMeta & { oauth: NonNullable<AdapterMeta["oauth"]> } }) {
  const [busy, setBusy] = useState(false);
  const origin = meta.oauth.fixedOrigin ? undefined : connectOriginProblem(window.location.origin);
  const blocked = !!meta.oauth.setup || !!origin;
  const go = async () => { setBusy(true); if (!(await startOAuth(meta.oauth.label))) setBusy(false); };
  return (
    <div data-slot="oauth-connect-new" className="space-y-3">
      {blocked
        ? <OAuthBlocked setup={meta.oauth.setup} origin={origin} docs={meta.oauth.docs} />
        : <Button type="button" className="w-full" disabled={busy} onClick={() => void go()} data-slot="oauth-sign-in"><BrandIcon kind={meta.kind} />{meta.oauth.label}</Button>}
    </div>
  );
}

function IntegrationDialog({ kinds, options, existing, onClose, onSaved }: { kinds: AdapterMeta[]; options: InstanceOption[]; existing?: IntegrationCard; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState(existing?.kind ?? kinds[0]?.kind ?? "");
  const meta = kinds.find((k) => k.kind === kind);
  const [name, setName] = useState(existing?.name ?? "");
  const [id, setId] = useState(existing?.id ?? "");
  const instances = instanceChoices().length ? instanceChoices() : [thisInstance() ?? "local"];
  // A new integration is Automatic: any server's primary bridge runs it. Pinning is the advanced choice.
  const [instance, setInstance] = useState(existing?.instance ?? AUTO_INSTANCE);
  const pinned = [...new Set([...options.map((o) => o.id), ...instances, ...(isAutomatic(instance) ? [] : [instance])])];
  const [secretRef, setSecretRef] = useState(existing?.secretRef ?? "");
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(existing?.config ?? {}).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  const autoId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // A kind that takes a pasted key (Granola): the value goes to the save once, and the server stores
  // it in the secret store. Empty on an edit keeps the stored key.
  const [apiKey, setApiKey] = useState("");
  const body = { id: autoId, kind, name, instance, secretRef: secretRef || (existing ? "" : meta?.secretDefault ?? ""), config, enabled: existing?.enabled ?? true, ...(meta?.apiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
  // A kind whose secret is a server key (shared/serverKeys.ts): env only, and greyed out with the
  // variable it needs while this server lacks it.
  const serverKey = meta?.serverKey;
  const keyMissing = !!serverKey && !serverKey.configured && !existing;
  const problem = integrationProblem(body, kinds.map((k) => k.kind), STRIPPED) ?? serverKeyRefusal(body)
    ?? (keyMissing ? needsNote(serverKey!) : undefined)
    ?? (meta?.apiKey && (apiKey.trim() || !existing) ? apiKeyProblem(meta, apiKey) : undefined);
  const save = async () => { setBusy(true); const r = await act(existing ? `Save ${name}` : `Connect ${name}`, "save", body, onSaved); setBusy(false); if (r) onClose(); };
  const kindSelect = (
    <Field label="Kind" htmlFor="int-kind">
      <Select value={kind} onValueChange={setKind} disabled={!!existing}>
        <SelectTrigger id="int-kind" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{kinds.map((k) => (
          <SelectItem key={k.kind} value={k.kind}>
            <BrandIcon kind={k.kind} className="mr-2" />{k.label}
            {k.serverKey && !k.serverKey.configured && <span data-slot="kind-not-set-up" className="text-muted-foreground ml-2 text-xs">not set up</span>}
          </SelectItem>
        ))}</SelectContent>
      </Select>
    </Field>
  );
  // An OAuth kind connects by sign-in only: the kind, then one button. No name, id or secret.
  if (!existing && meta?.oauth) return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-slot="integration-connect-dialog">
        <DialogHeader>
          <DialogTitle>Connect an integration</DialogTitle>
          {meta.help && <DialogDescription>{meta.help}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-4">
          {kindSelect}
          <OAuthConnect meta={{ ...meta, oauth: meta.oauth }} />
        </div>
        <DialogFooter><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return (
    <FormDialog title={existing ? `Edit ${existing.name}` : "Connect an integration"} problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description={meta?.help ?? "The token stays in the instance's environment. Orca stores only the variable name."}>
      {kindSelect}
      {keyMissing && <p data-slot="server-key-missing" className="text-muted-foreground rounded-md bg-muted p-3 text-xs">{needsNote(serverKey!)}</p>}
      <fieldset disabled={keyMissing} data-slot="integration-fields" className="space-y-4 disabled:opacity-50">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="int-name"><Input id="int-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Work ${meta?.label ?? ""}`.trim()} /></Field>
        <Field label="Id" htmlFor="int-id"><Input id="int-id" value={existing ? existing.id : id} disabled={!!existing} onChange={(e) => setId(e.target.value)} placeholder={autoId || "work-slack"} className="font-mono" /></Field>
      </div>
      <Field label="Runs on" htmlFor="int-instance" hint={isAutomatic(instance)
        ? "Automatic: the primary bridge of one server opens the connection. If that server stops, another server takes over."
        : "Only this server opens the connection. Use this for a personal account on your own machine."}>
        <Select value={instance} onValueChange={setInstance}>
          <SelectTrigger id="int-instance" data-slot="integration-instance" className="w-full"><SelectValue>{instanceText(instance, options)}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_INSTANCE}>
              <span className="flex flex-col"><span>Automatic</span><span className="text-muted-foreground text-xs">Any server. Recommended.</span></span>
            </SelectItem>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Pin to one server</SelectLabel>
              {pinned.map((i) => (
                <SelectItem key={i} value={i}>
                  <span className="flex flex-col"><span>{instanceText(i, options)}</span>{instanceText(i, options) !== i && <span className="text-muted-foreground font-mono text-xs">{i}</span>}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {meta?.apiKey && (
        <Field label={meta.apiKey.label} htmlFor="int-api-key" hint={meta.apiKey.hint}>
          <Input id="int-api-key" data-slot="integration-api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing ? "Stored. Paste a new key to replace it." : meta.apiKey.placeholder} className="font-mono" />
        </Field>
      )}
      {!meta?.oauth && !meta?.apiKey && <>
      <Field label="Secret variable" htmlFor="int-secret" hint={storedSecretName(secretRef) !== undefined
        ? <>From Orca&apos;s secret store. The bridge decrypts it in memory when the integration starts.</>
        : serverKey
          ? <>A server key: set it in the <span className="font-mono">.env</span> of {isAutomatic(instance) ? "each server that can run it" : "that server"}. Empty = <span className="font-mono">{meta?.secretDefault}</span>.</>
          : <>Set it in the <span className="font-mono">.env</span> of {isAutomatic(instance) ? "each server that can run it" : "that server"}. It must start with <span className="font-mono">ORCA_SECRET_</span>, so agents never see it. Or choose a stored secret below.</>}>
        <Input id="int-secret" value={secretRef} onChange={(e) => setSecretRef(secretRefInput(e.target.value))} placeholder={meta?.secretExample ?? "ORCA_SECRET_…"} className="font-mono" />
      </Field>
      {!serverKey && (
        <Field label="Stored secret" htmlFor="int-stored-secret">
          <StoredSecretSelect id="int-stored-secret" value={storedSecretName(secretRef) ?? ""} onChange={(v) => setSecretRef(v ? `${STORED_SECRET_PREFIX}${v}` : storedSecretName(secretRef) !== undefined ? "" : secretRef)} />
        </Field>
      )}
      </>}
      {meta?.config?.map((f) => meta.switches && f.key in meta.switches
        ? (
          <div key={f.key} className="flex items-center justify-between gap-3">
            <Label htmlFor={`int-cfg-${f.key}`}>{f.label}</Label>
            <Switch id={`int-cfg-${f.key}`} data-slot={`int-cfg-${f.key}`} checked={switchOn(config[f.key], meta.switches[f.key]!)} onCheckedChange={(on) => setConfig({ ...config, [f.key]: on ? "true" : "false" })} />
          </div>
        )
        : (
          <Field key={f.key} label={f.label} htmlFor={`int-cfg-${f.key}`}>
            <Input id={`int-cfg-${f.key}`} value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
          </Field>
        ))}
      </fieldset>
    </FormDialog>
  );
}

const NO_STORED_SECRET = "__none__";

/** The secret field as typed: a variable name in capitals, or `secret:<stored name>` kept as is. */
const secretRefInput = (v: string): string =>
  /^secret:/i.test(v) ? `${STORED_SECRET_PREFIX}${v.slice(STORED_SECRET_PREFIX.length)}` : v.toUpperCase();

/** A stored Orca secret by name (the store gives names only, never a value), or none: then the
 *  secret variable above holds the token. A pick writes `secret:<name>` as the secret_ref. */
export function StoredSecretSelect({ id, value, onChange, noneLabel = "None: use a secret variable" }: { id: string; value: string; onChange: (v: string) => void; noneLabel?: string }) {
  const [names, setNames] = useState<string[] | undefined>();
  useEffect(() => {
    let live = true;
    api.secretNames().then((r) => { if (live) setNames(r.secrets.map((s) => (s.scope === "default" ? s.name : `${s.scope}/${s.name}`))); }).catch(() => { if (live) setNames([]); });
    return () => { live = false; };
  }, []);
  const choices = [...new Set([...(names ?? []), ...(value ? [value] : [])])];
  return (
    <Select value={value || NO_STORED_SECRET} onValueChange={(v) => onChange(v === NO_STORED_SECRET ? "" : v)}>
      <SelectTrigger id={id} data-slot="integration-stored-secret" className="w-full font-mono"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_STORED_SECRET}><span className="font-sans">{noneLabel}</span></SelectItem>
        {choices.length > 0 && <SelectSeparator />}
        {choices.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
        {names !== undefined && !names.length && <SelectGroup><SelectLabel className="font-sans">No stored secrets yet. Save one with /secret in the chat.</SelectLabel></SelectGroup>}
      </SelectContent>
    </Select>
  );
}

function LinkDialog({ integration: c, meta, link, onClose, onSaved }: { integration: IntegrationCard; meta?: AdapterMeta; link?: LinkRow; onClose: () => void; onSaved: () => void }) {
  const repos = useRepos().map((r) => r.name);
  const [externalId, setExternalId] = useState(link?.externalId ?? "");
  const [label, setLabel] = useState(link?.label ?? "");
  const [level, setLevel] = useState<LinkLevel>(link?.level ?? "notify");
  const [chosen, setChosen] = useState<string[]>(link?.repos ?? []);
  const [mention, setMention] = useState(link?.requireMention ?? true);
  const [notifyMe, setNotifyMe] = useState(link?.notifyMe !== false);
  const [notifyAgent, setNotifyAgent] = useState(link?.notifyAgent !== false);
  const [busy, setBusy] = useState(false);
  const id = link?.id ?? `${c.id}-${(label || externalId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 63);
  const body = { id, integrationId: c.id, externalId, label, level, repos: repoScoped(level) ? chosen : [], requireMention: mention, notifyMe, notifyAgent };
  const problem = linkProblem(body);
  const place = meta?.place ?? "place";
  const save = async () => { setBusy(true); const r = await act(`Save link ${label || externalId}`, "links/save", body, onSaved); setBusy(false); if (r) onClose(); };
  return (
    <FormDialog title={link ? `Edit ${link.label ?? link.externalId}` : `Link a ${place} on ${c.name}`} problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description="The level caps what a sender here can ask Orca to do. A person's own level caps it again.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${place[0]!.toUpperCase()}${place.slice(1)} id`} htmlFor="link-ext"><Input id="link-ext" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="C0123ABC" className="font-mono" /></Field>
        <Field label="Label" htmlFor="link-label"><Input id="link-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="#eng" /></Field>
      </div>
      <Field label="Level" htmlFor="link-level" hint={level === "notify" ? "Orca posts here. It ignores messages." : level === "ask" ? "Senders can ask about status, PRs and the board." : level === "work" ? "Senders can also start, steer, stop, archive and queue merges on the repos below." : "Senders can run every orca verb on the repos below, plus move, sweep and repo add. Not settings or notes."}>
        <Select value={level} onValueChange={(v) => setLevel(v as LinkLevel)}>
          <SelectTrigger id="link-level" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      {repoScoped(level) && (
        <Field label="Repos">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {repos.map((r) => (
              <li key={r} className="flex items-center gap-2">
                <Checkbox id={`link-repo-${r}`} checked={chosen.includes(r)} onCheckedChange={(v) => setChosen(v === true ? [...chosen, r] : chosen.filter((x) => x !== r))} />
                <Label htmlFor={`link-repo-${r}`} className="font-normal">{r}</Label>
              </li>
            ))}
          </ul>
        </Field>
      )}
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="link-mention">Only when @-mentioned</Label>
        <Switch id="link-mention" checked={mention} onCheckedChange={setMention} />
      </div>
      {NOTIFY_SWITCHES.map(({ key, label, slot, hint }) => (
        <div key={key} className="space-y-1.5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={slot}>{label}</Label>
            <Switch id={slot} checked={key === "notifyMe" ? notifyMe : notifyAgent} onCheckedChange={key === "notifyMe" ? setNotifyMe : setNotifyAgent} />
          </div>
          <div className="text-muted-foreground text-xs">{hint}</div>
        </div>
      ))}
    </FormDialog>
  );
}

// ── people and pairing ───────────────────────────────────────────────────────────────────────────

/** People are global: one person has identities on every adapter (Discord, Slack, email…), one
 *  level for all of them, and a pairing from any adapter can join an existing person. */
function PeopleCard({ data, onChange }: { data: Overview; onChange: () => void }) {
  const [approve, setApprove] = useState<Pairing | null>(null);
  const [adding, setAdding] = useState(false);
  const integrationName = (id: string) => data.integrations.find((c) => c.id === id)?.name ?? id;
  return (
    <div>
      <SectionTitle aside={<Button variant="ghost" size="sm" onClick={() => setAdding(true)} data-slot="person-add"><Plus />Add person</Button>}>People</SectionTitle>
      <VCard slot="integration-people" bodyClass="divide-y">
        {data.pairings.map((p) => (
          <div key={p.code} data-slot="pairing" className="bg-geist-amber/5 flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="amber">Pairing {p.code}</Pill>
                <span className="font-medium">{p.name ?? p.externalId}</span>
              </div>
              <div className="text-muted-foreground mt-1 text-xs break-words">{identityLabel(p, data.kinds)} · <span className="font-mono">{p.externalId}</span> · via {integrationName(p.integrationId)} · {ago(p.createdAt)}</div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setApprove(p)} className="max-sm:h-10 max-sm:flex-1">Approve</Button>
              <Button size="sm" variant="secondary" onClick={() => void act(`Deny ${p.code}`, "pairing/deny", { code: p.code }, onChange)} className="max-sm:h-10 max-sm:flex-1">Deny</Button>
            </div>
          </div>
        ))}
        {data.people.length === 0 && data.pairings.length === 0 && <Empty>No people yet. Add one here, or use Add to person on a message in the Inbox or the chat.</Empty>}
        {data.people.map((p) => <PersonRowView key={p.id} person={p} kinds={data.kinds} onChange={onChange} />)}
      </VCard>
      {approve && <ApproveDialog pairing={approve} people={data.people} onClose={() => setApprove(null)} onSaved={onChange} />}
      {adding && <PersonDialog people={data.people} onClose={() => setAdding(false)} onSaved={onChange} />}
    </div>
  );
}

function PersonRowView({ person: p, kinds, onChange }: { person: PersonRow; kinds: AdapterMeta[]; onChange: () => void }) {
  const [ask, confirmNode] = useConfirm();
  const [adding, setAdding] = useState(false);
  return (
    <div data-slot="person" className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{p.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {p.identities.length === 0 && <span className="text-muted-foreground text-xs">no identities</span>}
          {p.identities.map((i) => (
            <span key={`${i.adapter}:${i.externalId}`} data-slot="person-identity" className="bg-muted inline-flex h-6 items-center gap-1 rounded-full pr-1 pl-2 text-xs">
              <BrandIcon kind={i.adapter} className="size-3" />{identityLabel(i, kinds)}
              <button type="button" aria-label={`Remove ${identityLabel(i, kinds)}`} className="hover:bg-accent rounded-full p-0.5"
                onClick={() => ask(`Remove ${identityLabel(i, kinds)} from ${p.name}?`, "Messages from this identity are dropped again until it is paired.", () => void act("Remove identity", "identities/remove", { adapter: i.adapter, externalId: i.externalId }, onChange))}><X className="size-3" /></button>
            </span>
          ))}
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAdding(true)} aria-label={`Add identity to ${p.name}`}><Plus />Identity</Button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Select value={p.maxLevel} onValueChange={(v) => void act(`Set ${p.name}'s level`, "people/save", { ...p, maxLevel: v }, onChange)}>
          <SelectTrigger aria-label={`${p.name} max level`} size="sm" className="w-28 max-sm:h-10 max-sm:flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10 size-8 max-sm:size-10" aria-label={`Remove ${p.name}`}
          onClick={() => ask(`Remove ${p.name}?`, "Every identity is unpaired. Their messages are dropped again.", () => void act(`Remove ${p.name}`, "people/remove", { id: p.id }, onChange))}><Trash2 /></Button>
      </div>
      {adding && <IdentityDialog person={p} kinds={kinds} onClose={() => setAdding(false)} onSaved={onChange} />}
      {confirmNode}
    </div>
  );
}

function PersonDialog({ people, onClose, onSaved }: { people: PersonRow[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [maxLevel, setMaxLevel] = useState<LinkLevel>("ask");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(`Add ${name}`, "people/save", { id: personId(name, people.map((p) => p.id)), name: name.trim(), maxLevel }, onSaved);
    setBusy(false); if (r) onClose();
  };
  return (
    <FormDialog title="Add a person" problem={name.trim() ? undefined : "name is required"} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description="Then add their identities: one per platform. Their level caps every message from any of them.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="person-name"><Input id="person-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Max level" htmlFor="person-level">
          <Select value={maxLevel} onValueChange={(v) => setMaxLevel(v as LinkLevel)}>
            <SelectTrigger id="person-level" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
    </FormDialog>
  );
}

function IdentityDialog({ person: p, kinds, onClose, onSaved }: { person: PersonRow; kinds: AdapterMeta[]; onClose: () => void; onSaved: () => void }) {
  const [adapter, setAdapter] = useState(kinds[0]?.kind ?? "");
  const [externalId, setExternalId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const body = { principal: p.id, adapter, externalId: externalId.trim(), name: name.trim() };
  const problem = identityProblem(body, kinds.map((k) => k.kind));
  const save = async () => { setBusy(true); const r = await act(`Add identity to ${p.name}`, "identities/add", body, onSaved); setBusy(false); if (r) onClose(); };
  return (
    <FormDialog title={`Add an identity to ${p.name}`} problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description="The platform's own user id (Discord, Slack) or the email address. A message from it then counts as this person.">
      <Field label="Platform" htmlFor="identity-adapter">
        <Select value={adapter} onValueChange={setAdapter}>
          <SelectTrigger id="identity-adapter" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{kinds.map((k) => (
          <SelectItem key={k.kind} value={k.kind}>
            <BrandIcon kind={k.kind} className="mr-2" />{k.label}
            {k.serverKey && !k.serverKey.configured && <span data-slot="kind-not-set-up" className="text-muted-foreground ml-2 text-xs">not set up</span>}
          </SelectItem>
        ))}</SelectContent>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="User id or address" htmlFor="identity-id"><Input id="identity-id" value={externalId} onChange={(e) => setExternalId(e.target.value)} className="font-mono" /></Field>
        <Field label="Name there (optional)" htmlFor="identity-name"><Input id="identity-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="@handle" /></Field>
      </div>
    </FormDialog>
  );
}

function ApproveDialog({ pairing: p, people, onClose, onSaved }: { pairing: Pairing; people: PersonRow[]; onClose: () => void; onSaved: () => void }) {
  // A known name joins that person: the same human on a second platform is one person, one level.
  const [personId, setPersonId] = useState(() => people.find((x) => p.name && x.name.toLowerCase() === p.name.toLowerCase())?.id ?? "new");
  const [name, setName] = useState(p.name ?? "");
  const [maxLevel, setMaxLevel] = useState<LinkLevel>("ask");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(`Approve ${p.code}`, "pairing/approve", { code: p.code, ...(personId === "new" ? { name, maxLevel } : { principal: personId }) }, onSaved);
    setBusy(false); if (r) onClose();
  };
  return (
    <FormDialog title={`Approve ${p.name ?? p.externalId}`} busy={busy} onSubmit={() => void save()} onClose={onClose}
      problem={personId === "new" && !name.trim() ? "name is required" : undefined}
      description={<>Code <span className="font-mono">{p.code}</span> from {p.adapter} <span className="font-mono">{p.externalId}</span>. Pick an existing person to add this identity to them. Their messages then get min(link level, their level).</>}>
      <Field label="Person" htmlFor="pair-person">
        <Select value={personId} onValueChange={setPersonId}>
          <SelectTrigger id="pair-person" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="new">A new person</SelectItem>
            {people.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {personId === "new" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="pair-name"><Input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Max level" htmlFor="pair-level">
            <Select value={maxLevel} onValueChange={(v) => setMaxLevel(v as LinkLevel)}>
              <SelectTrigger id="pair-level" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{PAIRING_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

// ── subscriptions ────────────────────────────────────────────────────────────────────────────────

function SubscriptionsCard({ data, onChange }: { data: Overview; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <SectionTitle aside={<Button variant="ghost" size="sm" onClick={() => setOpen(true)}><Plus />Add</Button>}>Subscriptions</SectionTitle>
      <VCard slot="integration-subscriptions" bodyClass="divide-y">
        {data.subscriptions.length === 0 && <Empty icon={<Bell className="size-5" />}>Nothing goes out yet. Add a subscription to post Orca's events to a link.</Empty>}
        {data.subscriptions.map((s) => (
          <div key={s.id} data-slot="subscription" className="flex items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs">{s.topicPattern}</span>
                {Object.keys(s.filter).length > 0 && <span className="text-muted-foreground font-mono text-xs">[{filterText(s.filter)}]</span>}
                <span className="text-muted-foreground">→</span>
                <span className="break-words">{targetLabel(s, data.links, data.integrations)}</span>
                {s.digestSeconds && <Pill>digest {Math.round(s.digestSeconds / 60)} min</Pill>}
              </div>
            </div>
            <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10 size-8 max-sm:size-10" aria-label={`Remove subscription ${s.topicPattern}`}
              onClick={() => void act("Remove subscription", "subscriptions/remove", { id: s.id }, onChange)}><Trash2 /></Button>
          </div>
        ))}
      </VCard>
      {open && <SubscriptionDialog data={data} onClose={() => setOpen(false)} onSaved={onChange} />}
    </div>
  );
}

function SubscriptionDialog({ data, onClose, onSaved }: { data: Overview; onClose: () => void; onSaved: () => void }) {
  const [topicPattern, setTopic] = useState(SUBSCRIPTION_PRESETS[0]!.topicPattern);
  const [digest, setDigest] = useState<number | undefined>();
  const [filter, setFilter] = useState("");
  const [targetKind, setTargetKind] = useState<"link" | "orchestrator" | "agent" | "workstream" | "web">(data.links.length ? "link" : "web");
  const [targetId, setTargetId] = useState(data.links[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const parsed = parseFilter(filter);
  const problem = !topicPattern.trim() ? "a topic pattern is required" : !parsed ? "filter: repo=…, branch=… or adapter=…, comma-separated"
    : targetKind === "link" && !targetId ? "pick a link" : targetKind === "agent" && !targetId ? "pick an agent" : targetKind === "workstream" && !/^[^:]+::.+$/.test(targetId) ? "workstream: repo::branch" : undefined;
  const save = async () => {
    setBusy(true);
    const r = await act(`Add subscription ${topicPattern}`, "subscriptions/add", { topicPattern, filter: parsed ?? {}, targetKind, ...(targetKind === "link" || targetKind === "workstream" || targetKind === "agent" ? { targetId } : {}), ...(digest ? { digestSeconds: digest } : {}) }, onSaved);
    setBusy(false); if (r) onClose();
  };
  return (
    <FormDialog title="Add a subscription" problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description="Events whose topic and filter match go to the target.">
      <div className="flex flex-wrap gap-1.5">
        {SUBSCRIPTION_PRESETS.map((p) => (
          <Button key={p.id} type="button" size="sm" variant={topicPattern === p.topicPattern && digest === p.digestSeconds ? "default" : "secondary"}
            onClick={() => { setTopic(p.topicPattern); setDigest(p.digestSeconds); }}>{p.label}</Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Topic pattern" htmlFor="sub-topic"><Input id="sub-topic" value={topicPattern} onChange={(e) => setTopic(e.target.value)} className="font-mono" /></Field>
        <Field label="Filter" htmlFor="sub-filter"><Input id="sub-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="repo=orca" className="font-mono" /></Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Target" htmlFor="sub-kind">
          <Select value={targetKind} onValueChange={(v) => { setTargetKind(v as typeof targetKind); setTargetId(v === "link" ? data.links[0]?.id ?? "" : v === "agent" ? data.agents?.[0]?.name ?? "" : ""); }}>
            <SelectTrigger id="sub-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="link" disabled={!data.links.length}>A link</SelectItem>
              <SelectItem value="orchestrator">The orchestrator</SelectItem>
              {(data.agents?.length ?? 0) > 0 && <SelectItem value="agent">A named agent</SelectItem>}
              <SelectItem value="workstream">A workstream</SelectItem>
              <SelectItem value="web">The web app</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {targetKind === "link" && (
          <Field label="Link" htmlFor="sub-link">
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="sub-link" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{data.links.filter((l) => l.externalId !== CATCH_ALL).map((l) => <SelectItem key={l.id} value={l.id}>{targetLabel({ targetKind: "link", targetId: l.id }, data.links, data.integrations)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        {targetKind === "agent" && (
          <Field label="Agent" htmlFor="sub-agent">
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="sub-agent" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{(data.agents ?? []).map((a) => <SelectItem key={a.name} value={a.name}>{a.displayName}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        {targetKind === "workstream" && <Field label="Workstream" htmlFor="sub-ws"><Input id="sub-ws" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="orca::main" className="font-mono" /></Field>}
      </div>
    </FormDialog>
  );
}

// ── dead deliveries ──────────────────────────────────────────────────────────────────────────────

function DeadCard({ data, onChange }: { data: Overview; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const all = async () => { setBusy(true); await act("Retry all deliveries", "deliveries/retry", {}, onChange); setBusy(false); };
  return (
    <div>
      <SectionTitle aside={data.dead.length > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void all()}><RotateCw />Retry all</Button>}>
        Dead deliveries{data.dead.length > 0 ? ` · ${data.dead.length}` : ""}
      </SectionTitle>
      <VCard slot="integration-dead" bodyClass="divide-y">
        {data.dead.length === 0 && <Empty>No dead deliveries. Every send went out or is still retrying.</Empty>}
        {data.dead.map((d) => (
          <div key={d.id} data-slot="dead-delivery" className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusDot tone="error" />
                <span className="font-medium break-words">{d.title ?? d.topic}</span>
                <span className="text-muted-foreground">→ {deadTargetLabel(d.target)}</span>
              </div>
              <div className="text-muted-foreground mt-1 text-xs break-words">
                <span className="font-mono">{d.topic}</span> · {d.attempts} attempts{d.at ? ` · ${ago(d.at)}` : ""}{d.lastError ? ` · ${d.lastError}` : ""}
              </div>
            </div>
            <Button variant="secondary" size="sm" className="max-sm:h-10" onClick={() => void act(`Retry delivery ${d.id}`, "deliveries/retry", { id: d.id }, onChange)}>Retry</Button>
          </div>
        ))}
      </VCard>
    </div>
  );
}
