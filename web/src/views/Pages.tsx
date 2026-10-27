// The sidebar's other pages. Settings: appearance, the Repos section (one row per configured repo
// with its agents' numbers; a click opens Agents scoped to it), the GitHub section, the Board view (shown or
// hidden for every browser) and its density, each machine's hourly cost (editable: the
// instance cards' Cost · this month), and the configuration this bridge runs with (read-only — it
// is edited in orca.config.ts / the config table, not here). Notifications: do not
// disturb, browser notifications, and which kinds pop a toast (the centre keeps every kind).
import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, FolderGit2, GitBranch, Server, SquareTerminal } from "lucide-react";
import { api, type GithubAccount, type GoogleOAuthSettings } from "../api";
import { refreshVitals } from "@/lib/vitals";
import { notifyLocal, setBrowserNotify } from "@/lib/notificationStore";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { browserNotifyAtom, densityAtom, instanceScopeAtom, notifyDndAtom, repoFilterAtom, toastPrefsAtom } from "@/lib/atoms";
import { KIND_META, NOTIFICATION_KINDS, browserNotifyChecked, browserNotifyNote, browserPermission } from "../../../shared/notifications";
import { navigate, useRoute } from "@/lib/route";
import { useTheme, type Theme } from "@/lib/theme";
import { instanceChoices, setInstanceRate, setInstanceTerminal, setShowBoard, staleHours, terminalContext, thisInstance, useAgentProviders, useInstanceRates, useInstanceTerminals, useRepos, useShowBoard, useWorkstreams } from "../store";
import { terminalMachines, useOpenTerminal } from "@/components/InstanceTerminal";
import { ago, repoSummaries, terminalBlocked } from "../workstream";
import { Detail, Empty, Pill, SectionTitle, Segmented, StatusDot, VCard } from "@/components/console";
import { BrandName, FindBox, HandoffsBadge, NAV, OrcaMark, THEMES, navShown } from "@/components/Shell";
import { Tip } from "@/components/ui/tip";
import { cn } from "@/lib/utils";
import { loadIdentity, useServerIdentity } from "@/lib/identity";
import { IDENTITY_NAME_MAX, NEUTRAL, colorFromName, colorGrid, isNeutral, markBg, markColor, normalizeColor, normalizeTheme, swatchBackground, type GridCell } from "../../../shared/serverIdentity";
import { RunningPreviews, TestMaster } from "./PreviewControl";
import { StoredSecretSelect } from "./Integrations";
import { AgentsSettings } from "./AgentSettings";

/** A section of Settings with an anchor: `/settings#repos` (the old /repos) scrolls to it. */
function SettingsSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <div id={id} data-slot={`settings-${id}`} className="scroll-mt-20"><SectionTitle>{title}</SectionTitle>{children}</div>;
}

function ReposSection() {
  const repos = useRepos();
  const rows = useWorkstreams();
  const setRepo = useSetAtom(repoFilterAtom);
  const summaries = repoSummaries(rows, repos.map((r) => r.name));
  return (
    <SettingsSection id="repos" title="Repos">
      <VCard slot="repos-list">
        {summaries.length === 0 ? <Empty>No repos configured.</Empty> : (
          <ul className="divide-y">
            {summaries.map((s) => {
              const info = repos.find((r) => r.name === s.repo)!;
              return (
                <li key={s.repo}>
                  <button type="button" data-slot="repo-row" onClick={() => { setRepo(s.repo); navigate("/agents"); }}
                    className="hover:bg-accent/40 grid w-full grid-cols-[minmax(12rem,1.5fr)_repeat(4,6rem)_7rem] items-center gap-4 px-4 py-3 text-left text-sm">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-md border"><FolderGit2 className="size-4" /></span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.repo}</span>
                        <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs"><GitBranch className="size-3" />{info.baseBranch}{info.runsOn ? ` · runs on ${info.runsOn}` : ""}{info.hasRemote ? "" : " · local only"}</span>
                      </span>
                    </span>
                    <Count label="Running" n={s.running} />
                    <Count label="Needs you" n={s.attention} />
                    <Count label="Open PRs" n={s.openPrs} />
                    <Count label="Merged today" n={s.mergedToday} />
                    <span className="text-muted-foreground text-right text-xs">{s.lastActivity ? ago(s.lastActivity) : "no activity"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </VCard>
    </SettingsSection>
  );
}

const Count = ({ label, n }: { label: string; n: number }) => (
  <span className="min-w-0">
    <span className="text-muted-foreground block text-xs">{label}</span>
    <span className={`block tabular-nums ${n ? "text-foreground font-medium" : "text-muted-foreground"}`}>{n}</span>
  </span>
);

export function Settings() {
  const [theme, setTheme] = useTheme();
  const repos = useRepos();
  const providers = useAgentProviders();
  const here = thisInstance();
  // The old /repos and /github land here with a #hash: scroll to that section, on each navigation.
  const route = useRoute();
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [route]);
  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-heading text-2xl font-semibold tracking-tight max-md:hidden">Settings</h1>
      <MobileNav />
      <VCard slot="settings-appearance" title="Appearance" bodyClass="divide-y">
        <Setting label="Theme" hint="Light, dark, or follow the system.">
          <Segmented label="Theme" value={theme} onChange={(v) => setTheme(v as Theme)} options={THEMES.map((t) => ({ value: t.value, label: t.label }))} />
        </Setting>
        <BoardSettings />
      </VCard>
      <ServerIdentitySettings />
      <NotificationSettings />
      <MachineCostSettings />
      <InstancesSettings />
      <GoogleSignInSettings />
      <AgentsSettings />
      <ReposSection />
      <GitHubSection />
      <VCard slot="settings-config" title="Configuration" aside={<span className="text-muted-foreground text-xs">read-only · orca.config.ts</span>}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b p-4 sm:grid-cols-4">
          <Detail label="This instance"><StatusDot tone="ready" />{here ?? "—"}</Detail>
          <Detail label="Instances">{instanceChoices().join(", ") || here || "—"}</Detail>
          <Detail label="Agent CLIs">{providers.map((p) => <Pill key={p}>{p}</Pill>)}</Detail>
          <Detail label="Bump after">{staleHours()}h</Detail>
        </div>
        <ul className="divide-y">
          {repos.map((r) => (
            <li key={r.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground font-mono text-xs">base {r.baseBranch}</span>
              {r.runsOn && <Pill>runs on {r.runsOn}</Pill>}
              {r.slackChannel && <Pill>#{r.slackChannel.replace(/^#/, "")}</Pill>}
              {r.defaultModel && <Pill>{r.defaultModel}</Pill>}
              {!r.hasRemote && <Pill>local only</Pill>}
            </li>
          ))}
        </ul>
      </VCard>
    </div>
  );
}

/** The Board view: shown or hidden for every browser (`ui.showBoard` in the config document), and
 *  its card density (this browser only). */
function BoardSettings() {
  const show = useShowBoard();
  const [density, setDensity] = useAtom(densityAtom);
  const [busy, setBusy] = useState(false);
  const set = async (value: boolean) => {
    setBusy(true);
    try { await setShowBoard(value); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({
        kind: "action_failed", repo: "", title: "Board view", label: "Board setting failed", body: error,
        copy: `Action: ${value ? "Show" : "Hide"} the Board view\nError:\n${error}`,
        ask: `${value ? "Showing" : "Hiding"} the Board view failed: ${error}. Please investigate and fix.`,
      });
    }
    finally { setBusy(false); }
  };
  return (
    <>
      <Setting label="Show Board view" hint="The Board page and its nav entry, for every browser." htmlFor="setting-show-board">
        <Switch id="setting-show-board" data-slot="show-board-switch" checked={show} disabled={busy} onCheckedChange={(v) => void set(v)} />
      </Setting>
      {show && (
        <Setting label="Board density" hint="The Board view's cards: full, or status only.">
          <Segmented label="Density" value={density} onChange={setDensity} options={[{ value: "comfortable", label: "Comfortable" }, { value: "dense", label: "Dense" }]} />
        </Setting>
      )}
    </>
  );
}

/** Settings → Google sign-in: the OAuth client behind Gmail's "Sign in with Google", set once by the
 *  operator (`googleOAuth` in the app config; docs/integrations/gmail.md). The client id (empty =
 *  ORCA_GOOGLE_OAUTH_CLIENT_ID), the client secret as a stored secret (none = the ORCA_SECRET_GOOGLE_OAUTH
 *  variable) and an optional fixed redirect origin. The Integrations page's Connect has no such fields. */
function GoogleSignInSettings() {
  const [saved, setSaved] = useState<GoogleOAuthSettings | null>(null);
  const [form, setForm] = useState({ clientId: "", secretRef: "", redirectOrigin: "" });
  const [busy, setBusy] = useState(false);
  const load = () => api.config().then((c) => { if (c.googleOAuth) { setSaved(c.googleOAuth); setForm({ clientId: c.googleOAuth.clientId, secretRef: c.googleOAuth.secretRef, redirectOrigin: c.googleOAuth.redirectOrigin }); } }).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!saved) return null;
  const stored = form.secretRef.startsWith("secret:") ? form.secretRef.slice("secret:".length) : "";
  const changed = form.clientId !== saved.clientId || form.secretRef !== saved.secretRef || form.redirectOrigin !== saved.redirectOrigin;
  const origin = (form.redirectOrigin.trim() || window.location.origin).replace(/\/+$/, "");
  const save = async () => {
    setBusy(true);
    try { await api.setGoogleOAuth(form); await load(); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({ kind: "action_failed", repo: "", title: "Google sign-in", label: "Google sign-in setting failed", body: error, copy: `Action: Save the Google OAuth client\nError:\n${error}`, ask: `Saving the Google OAuth client failed: ${error}. Please investigate and fix.` });
    }
    finally { setBusy(false); }
  };
  return (
    <VCard slot="settings-google-oauth" title="Google sign-in" aside={<span className="text-muted-foreground text-xs">Gmail · set once</span>}>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-muted-foreground text-xs">The OAuth client for Sign in with Google. Make a Web client in Google Cloud and add this redirect URI: <span className="font-mono break-all">{origin}/api/integrations/oauth/google/callback</span></p>
        <div className="space-y-1.5">
          <Label htmlFor="google-client-id">Client ID</Label>
          <Input id="google-client-id" data-slot="google-client-id" className="font-mono" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            placeholder={saved.envClientId ? "empty = ORCA_GOOGLE_OAUTH_CLIENT_ID (set)" : "1234-abc.apps.googleusercontent.com"} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="google-client-secret">Client secret</Label>
          <StoredSecretSelect id="google-client-secret" value={stored} noneLabel={`None: use ${saved.defaultSecretRef} in .env`}
            onChange={(v) => setForm({ ...form, secretRef: v ? `secret:${v}` : "" })} />
          {form.secretRef && !stored && <div className="text-muted-foreground text-xs">Variable <span className="font-mono">{form.secretRef}</span></div>}
          <div className="text-muted-foreground text-xs">Save the secret first with /secret in the chat. Orca stores only its name here.</div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="google-redirect-origin">Redirect origin (optional)</Label>
          <Input id="google-redirect-origin" className="font-mono" value={form.redirectOrigin} onChange={(e) => setForm({ ...form, redirectOrigin: e.target.value })} placeholder="empty = the page's own https origin" />
        </div>
        <div className="flex justify-end"><Button size="sm" disabled={busy || !changed} onClick={() => void save()} data-slot="google-oauth-save">Save</Button></div>
      </div>
    </VCard>
  );
}

/** Phone-only (there is no off-canvas drawer any more): everything the sidebar carried that isn't
 *  one of the bottom bar's five destinations (Overview, Agents, New agent, Orchestrator, Settings
 *  itself) — Find, the instance switcher, and links to Previews, Integrations and Handoffs. Hidden on desktop,
 *  where the sidebar already has all of this. */
function MobileNav() {
  const [scope, setScope] = useAtom(instanceScopeAtom);
  const choices = instanceChoices();
  const showBoard = useShowBoard();
  const links = NAV.filter((n) => ["Board", "Inbox", "Memory", "Previews", "Integrations", "Handoffs"].includes(n.label) && navShown(n.to, showBoard));
  return (
    <VCard slot="settings-mobile-nav" title="Navigate" className="md:hidden" bodyClass="divide-y">
      <Setting label="Find agents" hint="Filters the Agents list.">
        <FindBox />
      </Setting>
      {choices.length > 1 && (
        <Setting label="Instance" hint="Scope the Overview and Agents pages to one machine.">
          <Segmented label="Instance" value={scope} onChange={setScope}
            options={[{ value: "all", label: "All" }, ...choices.map((i) => ({ value: i, label: i }))]} />
        </Setting>
      )}
      <nav aria-label="More pages">
        {links.map(({ to, label, Icon }) => (
          <button key={to} type="button" onClick={() => navigate(to)} className="hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-left text-sm">
            <Icon className="text-muted-foreground size-4" />{label}
            {to === "/handoffs" && <HandoffsBadge />}
          </button>
        ))}
      </nav>
    </VCard>
  );
}

function NotificationSettings() {
  const [dnd, setDnd] = useAtom(notifyDndAtom);
  const browser = useAtomValue(browserNotifyAtom);
  const [prefs, setPrefs] = useAtom(toastPrefsAtom);
  // Read again when the tab comes back: the user may have changed the site settings meanwhile.
  const [permission, setPermission] = useState(() => browserPermission());
  useEffect(() => {
    const reread = () => setPermission(browserPermission());
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  const browserNote = browserNotifyNote(permission);
  return (
    <VCard slot="settings-notifications" title="Notifications" bodyClass="divide-y">
      <Setting label="Do not disturb" hint="Silence the toasts; the centre still collects everything." htmlFor="setting-dnd">
        <Switch id="setting-dnd" checked={dnd} onCheckedChange={setDnd} />
      </Setting>
      <Setting label="Browser notifications" hint="When this tab is hidden: an agent needing input, a failure, a failed check."
        htmlFor={browserNote ? undefined : "setting-browser-notify"}
        note={browserNote && <p role="note" data-slot="browser-notify-note" className="text-foreground mt-1 text-xs">{browserNote}</p>}>
        {!browserNote && (
          <Switch id="setting-browser-notify" data-slot="browser-notify" checked={browserNotifyChecked(browser, permission)}
            onCheckedChange={(on) => { void setBrowserNotify(on).then(setPermission); }} />
        )}
      </Setting>
      <div className="px-4 py-3">
        <div className="text-sm font-medium">Toasts</div>
        <div className="text-muted-foreground mb-2 text-xs">Which kinds pop up in the corner.</div>
        <ul data-slot="notification-kinds" className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {NOTIFICATION_KINDS.map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Checkbox id={`toast-kind-${k}`} className="mt-0.5" checked={prefs[k] !== false}
                onCheckedChange={(v) => setPrefs({ ...prefs, [k]: v === true })} />
              <Label htmlFor={`toast-kind-${k}`} className="leading-5 font-normal">{KIND_META[k].label}</Label>
            </li>
          ))}
        </ul>
      </div>
    </VCard>
  );
}

/** Each machine's USD/hour — `instanceHourlyUsd` in the app config, what its card's Cost · this month
 *  cell accrues. Empty means automatic: an EC2 on-demand estimate, else 0. Read from the store's
 *  config mirror (no fetch of its own), written through the bridge. */
function MachineCostSettings() {
  const rates = useInstanceRates();
  const here = thisInstance();
  const machines = instanceChoices().length ? instanceChoices() : here ? [here] : [];
  if (!machines.length) return null;
  return (
    <VCard slot="settings-machine-cost" title="Machine cost" bodyClass="divide-y">
      {machines.map((m) => <MachineRate key={m} instance={m} saved={rates[m]} />)}
    </VCard>
  );
}

/** Settings → Instances: one row per machine, with its web terminal — the on/off Switch (`terminal`
 *  in the app config, OFF unless turned on here; this row is the only way to set it, as the bridge
 *  keeps it out of a pasted config document) and Open terminal, which opens the terminal panel
 *  (components/InstanceTerminal.tsx) on that machine. A disabled Open says why on the row. */
function InstancesSettings() {
  const on = useInstanceTerminals();
  const here = thisInstance();
  const machines = terminalMachines();
  const openTerminal = useOpenTerminal();
  const [busy, setBusy] = useState<string | null>(null);
  if (!machines.length) return null;
  const ctx = terminalContext();
  const set = async (instance: string, value: boolean) => {
    setBusy(instance);
    try { await setInstanceTerminal(instance, value); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({
        kind: "action_failed", repo: "", title: `Terminal · ${instance}`, label: "Terminal setting failed", body: error,
        copy: `Action: Turn the terminal ${value ? "on" : "off"} for ${instance}\nError:\n${error}`,
        ask: `Turning the terminal ${value ? "on" : "off"} for ${instance} failed: ${error}. Please investigate and fix.`,
      });
    }
    finally { setBusy(null); }
  };
  return (
    <VCard slot="settings-instances" title="Instances" bodyClass="divide-y">
      {machines.map((m) => {
        const why = terminalBlocked(m, on[m] === true, ctx);
        return (
          <div key={m} data-slot="instance-row" data-instance={m} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium"><Server className="text-muted-foreground size-4" />{m}{m === here && <span className="text-muted-foreground font-normal">· this machine</span>}</div>
              <div className="text-muted-foreground text-xs">Terminal: a shell as the Orca user. Owner only, 2 sessions, 30 minutes idle.</div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor={`terminal-${m}`} className="text-muted-foreground text-xs font-normal">Terminal</Label>
                <Switch id={`terminal-${m}`} data-slot="terminal-switch" aria-label={`${m} terminal`} checked={on[m] === true}
                  disabled={busy === m} onCheckedChange={(v) => void set(m, v)} />
              </div>
              {why && <span data-slot="terminal-blocked" className="text-muted-foreground text-xs">{why}</span>}
              <Button type="button" size="sm" variant="secondary" data-slot="terminal-open" disabled={why !== null} onClick={() => openTerminal(m)}>
                <SquareTerminal className="size-4" />Open terminal
              </Button>
            </div>
          </div>
        );
      })}
    </VCard>
  );
}

function MachineRate({ instance, saved }: { instance: string; saved: number | undefined }) {
  const [text, setText] = useState(saved === undefined ? "" : String(saved));
  useEffect(() => { setText(saved === undefined ? "" : String(saved)); }, [saved]);
  const [busy, setBusy] = useState(false);
  const value = text.trim() === "" ? null : Number(text);
  const valid = value === null || (Number.isFinite(value) && value >= 0);
  const dirty = (saved ?? null) !== value;
  const save = async () => {
    setBusy(true);
    try { await setInstanceRate(instance, value); void refreshVitals(); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({
        kind: "action_failed", repo: "", title: `Machine cost · ${instance}`, label: "Save rate failed", body: error,
        copy: `Action: Save rate for ${instance}\nError:\n${error}`,
        ask: `Save rate for ${instance} failed: ${error}. Please investigate and fix.`,
      });
    }
    finally { setBusy(false); }
  };
  return (
    <Setting label={instance} hint="USD per hour. Empty: an EC2 on-demand estimate, else 0.">
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (valid && dirty) void save(); }}>
        <span className="text-muted-foreground text-sm">$</span>
        <Input data-slot="machine-rate" aria-label={`${instance} USD per hour`} inputMode="decimal" placeholder="auto" value={text}
          onChange={(e) => setText(e.target.value)} aria-invalid={!valid}
          className="bg-background w-24 tabular-nums" />
        <span className="text-muted-foreground text-sm">/h</span>
        <Button type="submit" variant="secondary" size="sm" disabled={!valid || !dirty || busy}>Save</Button>
      </form>
    </Setting>
  );
}

/** Settings → Server identity: the ACTIVE server's display name and theme colour (Slack's workspace
 *  name and theme). Saved to that server's app config (`serverIdentity`); empty fields fall back to
 *  the Tailscale host name and the colour derived from the name. There is no Save button: a colour
 *  saves when picked, the name `IDENTITY_SAVE_DELAY_MS` after the last keystroke or on blur. A failed
 *  save puts the stored values back and raises the action-failed toast. */
export const IDENTITY_SAVE_DELAY_MS = 500;
function ServerIdentitySettings() {
  const identity = useServerIdentity();
  const [name, setName] = useState("");
  const [color, setColor] = useState(""); // "" = derived from the name
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typing = useRef(false); // the name field has focus: a save's reload must not overwrite it
  const chain = useRef<Promise<void>>(Promise.resolve()); // saves go out in order
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stored = identity?.stored;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  useEffect(() => { if (!typing.current) setName(stored?.name ?? ""); setColor(stored?.color ?? ""); }, [stored?.name, stored?.color]);
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(savedTimer.current); }, []);
  if (!identity) return null;
  const label = name.trim() || identity.host;
  const shown = normalizeTheme(color) ?? colorFromName(label);
  const save = (nextName: string, nextColor: string) => {
    clearTimeout(timer.current); timer.current = undefined;
    const n = nextName.trim(), c = normalizeTheme(nextColor) ?? "";
    const was = storedRef.current;
    if (n === (was?.name ?? "") && c === (was?.color ?? "")) return;
    setStatus("saving"); clearTimeout(savedTimer.current);
    chain.current = chain.current.then(async () => {
      try {
        await api.setServerIdentity(n, c); await loadIdentity();
        setStatus("saved"); savedTimer.current = setTimeout(() => setStatus("idle"), 2000);
      } catch (e) {
        setStatus("idle");
        const back = storedRef.current;
        setName(back?.name ?? ""); setColor(back?.color ?? "");
        const error = e instanceof Error ? e.message : String(e);
        notifyLocal({
          kind: "action_failed", repo: "", title: "Server identity", label: "Save identity failed", body: error,
          copy: `Action: Save server identity\nError:\n${error}`,
          ask: `Saving the server identity failed: ${error}. Please investigate and fix.`,
        });
      }
    });
  };
  const typeName = (v: string) => {
    setName(v); clearTimeout(timer.current);
    timer.current = setTimeout(() => save(v, color), IDENTITY_SAVE_DELAY_MS);
  };
  const pickColor = (c: string) => { setColor(c); save(name, c); };
  return (
    <VCard slot="settings-identity" title="Server identity" bodyClass="divide-y"
      aside={<span className="flex items-center gap-3">
        <span data-slot="identity-status" aria-live="polite" className="text-muted-foreground flex items-center gap-1 text-xs">
          {status === "saving" ? "Saving…" : status === "saved" ? <><Check className="size-3.5" /> Saved</> : null}
        </span>
        <span data-slot="identity-preview" className="flex items-center gap-2 text-sm font-medium">
          <span className="inline-flex size-5 items-center justify-center rounded-full" style={{ color: markColor(shown), background: markBg(shown) }}><OrcaMark className="size-3.5" /></span>
          <BrandName label={label} labelSlot="identity-preview-name" />
        </span>
      </span>}>
      <Setting label="Display name" htmlFor="identity-name" hint={`The title, the sidebar and the server menu show it. Empty: ${identity.host}.`}>
        <Input id="identity-name" data-slot="identity-name" value={name} maxLength={IDENTITY_NAME_MAX} placeholder={identity.host}
          onFocus={() => { typing.current = true; }}
          onBlur={() => { typing.current = false; if (timer.current) save(name, color); }}
          onChange={(e) => typeName(e.target.value)} className="bg-background w-44" />
      </Setting>
      <Setting label="Theme colour" hint={isNeutral(color) ? "Neutral: no theme. The sidebar is grey and the mark is black and white." : color ? "The sidebar, buttons, links, focus rings and the mark take it." : "Auto: from the name. The sidebar, buttons, links, focus rings and the mark take it."}>
        <ColorPicker value={shown} auto={!color} onChange={pickColor} />
      </Setting>
    </VCard>
  );
}

/** The colour grid as rows: the base hues, then each tint and shade level across every hue. */
const GRID = ((cols: GridCell[][]) => cols[0]!.map((_, r) => cols.map((col) => col[r]!)))(colorGrid());
const NEUTRAL_CELL: GridCell = { value: NEUTRAL, label: "Neutral" };
/** One grid cell's look, shared by Neutral and every colour so they match: size, corners, the
 *  selected ring's offset, and an inset hairline (an outer border made Neutral 2px larger and let its
 *  gradient show at the edge; the hairline also keeps Neutral's white half visible on a light popover). */
const SWATCH = "block size-5 shrink-0 rounded-[4px] inset-ring inset-ring-border ring-offset-1 ring-offset-popover";

/** The theme colour picker (a shadcn Popover; shadcn has no colour picker of its own): a trigger with
 *  the swatch and the colour's name, a Word-style grid (`colorGrid`: the presets and two more hues,
 *  each with its tints and shades), a hex field for a custom colour and Auto (from the name).
 *  Neutral (no theme) is the first cell, a labelled row above the grid. `onChange("")` is Auto. */
function ColorPicker({ value, auto, onChange }: { value: string; auto: boolean; onChange: (color: string) => void }) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(isNeutral(value) ? "" : value), [value]);
  const preset = [NEUTRAL_CELL, ...GRID.flat()].find((c) => c.value === value);
  // Only a whole #rrggbb applies: a 3-digit prefix would expand and jump the field mid-typing.
  const asHex = (v: string) => (/^#?[0-9a-f]{6}$/i.test(v) ? normalizeColor(v.startsWith("#") ? v : `#${v}`) : undefined);
  const typed = (v: string) => { setHex(v); const c = asHex(v); if (c) onChange(c); };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary" size="sm" data-slot="identity-color-trigger" aria-label={`Theme colour: ${preset?.label ?? value}${auto ? " (auto)" : ""}`}>
          <span aria-hidden="true" className="size-4 rounded-[4px] border" style={{ background: swatchBackground(value) }} />
          <span className={cn("max-w-[9rem] truncate", !preset && "font-mono")}>{preset?.label ?? value}</span>
          {auto && <span className="text-muted-foreground font-normal">Auto</span>}
          <ChevronDown className="text-muted-foreground size-3.5" />
        </Button>
      </PopoverTrigger>
      {/* The hex field takes the first focus: on a swatch, its tooltip opened over the caption. */}
      <PopoverContent align="end" className="w-[17rem]" data-slot="identity-picker"
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('[data-slot="identity-hex"]')?.focus(); }}>
        <div className="text-muted-foreground mb-2 text-xs font-medium">Theme colours</div>
        {/* Word's grid: the base hues in one row, then each hue's tints and shades in its column. */}
        <div role="radiogroup" aria-label="Theme colour" data-slot="identity-grid" className="flex flex-col gap-1">
          {/* Neutral: the first cell, with its name beside it, so "no theme" is never a guess. */}
          <button type="button" role="radio" aria-checked={isNeutral(value)} aria-label="Neutral"
            data-slot="identity-color" data-row="neutral" data-color={NEUTRAL} onClick={() => onChange(NEUTRAL)}
            className="hover:bg-accent focus-visible:ring-ring/40 mb-1.5 flex items-center gap-2 self-start rounded-md pr-2 text-xs font-medium outline-none focus-visible:ring-2">
            <span aria-hidden="true" data-slot="identity-swatch" className={cn(SWATCH, isNeutral(value) && "ring-foreground ring-2")}
              style={{ background: swatchBackground(NEUTRAL) }} />
            Neutral
          </button>
          {GRID.map((row, r) => (
            <div key={r} className={cn("grid grid-cols-10 gap-1", r === 1 && "mt-1.5")}>
              {row.map((c) => (
                <Tip key={c.value} label={c.label}>
                  <button type="button" role="radio" aria-checked={value === c.value} aria-label={c.label}
                    data-slot="identity-color" data-row={r === 0 ? "base" : "tone"} data-color={c.value}
                    onClick={() => onChange(c.value)}
                    className={cn(SWATCH, "focus-visible:ring-ring/40 outline-none focus-visible:ring-2", value === c.value && "ring-foreground ring-2")}
                    style={{ background: c.value }} />
                </Tip>
              ))}
            </div>
          ))}
        </div>
        <div className="text-muted-foreground mt-3 mb-2 text-xs font-medium">Custom</div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" data-slot="identity-custom-swatch" className="size-8 shrink-0 rounded-md border" style={{ background: asHex(hex) ?? swatchBackground(value) }} />
          <Input data-slot="identity-hex" aria-label="Hex colour" value={hex} maxLength={7} spellCheck={false} placeholder="#2f6feb"
            onChange={(e) => typed(e.target.value.trim())} className="bg-background h-8 font-mono" />
        </div>
        <Button type="button" variant="ghost" size="sm" data-slot="identity-auto" disabled={auto} onClick={() => onChange("")} className="mt-3 w-full justify-start">
          {auto && <Check className="size-3.5" />} Auto: from the name
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** One settings row: the label and hint on the left, the control on the right. `htmlFor` names the
 *  control, so a click on the label works it; `note` goes under the hint (a control that can't work). */
const Setting = ({ label, hint, htmlFor, note, children }: { label: string; hint: string; htmlFor?: string; note?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 px-4 py-3">
    <div className="min-w-0">
      {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <div className="text-sm font-medium">{label}</div>}
      <div className="text-muted-foreground text-xs">{hint}</div>
      {note}
    </div>
    {children}
  </div>
);

/** GitHub: the `gh` accounts signed in on THIS machine (a work one and a personal one), which repos
 *  use each, and the name + email their commits carry — the GitHub profile's unless set here; a save
 *  goes to the shared config (`githubAccounts`), so no clone needs its own `git config`. Signing in
 *  another account is `gh auth login` in a terminal — a device-code flow Orca does not wrap. */
export function GitHubSection() {
  const [accounts, setAccounts] = useState<GithubAccount[] | null>(null);
  useEffect(() => { void api.githubAccounts().then((r) => setAccounts(r.accounts)).catch(() => setAccounts([])); }, []);
  return (
    <SettingsSection id="github" title="GitHub">
      <VCard slot="github-accounts" bodyClass="divide-y">
        {accounts === null ? <Empty>Loading…</Empty>
          : accounts.length === 0 ? <Empty>No gh account is signed in on this machine.</Empty>
          : accounts.map((a) => <AccountRowView key={a.login} account={a} onSaved={setAccounts} />)}
        <div className="text-muted-foreground px-4 py-3 text-xs">
          Add an account on this machine: <code className="font-mono">gh auth login</code>. Pin a repo to one with <code className="font-mono">githubUser</code> in its config, or ask Orca to add the repo — it picks the account that owns it.
        </div>
      </VCard>
    </SettingsSection>
  );
}

/** The account's GitHub profile image, round, left of the login — on a failed load (a dead login,
 *  no network) it falls back to the first letter of the login, same size and position. */
function AccountAvatar({ login, avatarUrl }: { login: string; avatarUrl?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="bg-muted relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border text-xs font-medium">
      {avatarUrl && !failed
        ? <img src={avatarUrl} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
        : login.charAt(0).toUpperCase()}
    </span>
  );
}

function AccountRowView({ account: a, onSaved }: { account: GithubAccount; onSaved: (rows: GithubAccount[]) => void }) {
  const [name, setName] = useState(a.configured.name ?? "");
  const [email, setEmail] = useState(a.configured.email ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(a.configured.name ?? ""); setEmail(a.configured.email ?? ""); }, [a.configured.name, a.configured.email]);
  const dirty = name !== (a.configured.name ?? "") || email !== (a.configured.email ?? "");
  const save = async () => {
    setBusy(true);
    try { onSaved((await api.setGithubAccount(a.login, { name, email })).accounts); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({ kind: "action_failed", repo: "", title: `GitHub · ${a.login}`, label: "Save identity failed", body: error, copy: `Action: Save identity for ${a.login}\nError:\n${error}`, ask: `Save identity for ${a.login} failed: ${error}. Please investigate and fix.` });
    } finally { setBusy(false); }
  };
  const reposText = a.repos.length ? a.repos.join(", ") : "no repos";
  return (
    <div data-slot="github-account" className="flex flex-col gap-3 px-4 py-3 text-sm md:grid md:grid-cols-[minmax(12rem,1fr)_auto] md:items-center md:gap-4">
      <div className="flex min-w-0 items-start gap-2.5 md:items-center">
        <AccountAvatar login={a.login} avatarUrl={a.avatarUrl} />
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-medium">{a.login}{a.active && <Pill>active</Pill>}</span>
          <span className="text-muted-foreground block break-words text-xs md:truncate">
            commits as {a.name ?? "—"} &lt;{a.email ?? "—"}&gt;<span className="hidden md:inline"> · {reposText}</span>
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs md:hidden">{reposText}</span>
        </span>
      </div>
      <form className="flex flex-col gap-2 md:flex-row md:items-center" onSubmit={(e) => { e.preventDefault(); if (dirty) void save(); }}>
        <Input aria-label={`${a.login} name`} placeholder={a.name ?? "name"} value={name} onChange={(e) => setName(e.target.value)}
          className="bg-background h-10 md:h-8 md:w-36" />
        <Input aria-label={`${a.login} email`} placeholder={a.email ?? "email"} value={email} onChange={(e) => setEmail(e.target.value)} type="email"
          className="bg-background h-10 md:h-8 md:w-56" />
        <Button type="submit" variant="secondary" size="sm" disabled={!dirty || busy} className="h-10 w-full md:h-8 md:w-auto">Save</Button>
      </form>
    </div>
  );
}

/** Previews: every live preview across instances (Open / Stop), and Test master — a preview of each
 *  repo's base branch. The sidebar's Previews item carries the badges (running count, base preview). */
export function PreviewsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-heading text-2xl font-semibold tracking-tight max-md:hidden">Previews</h1>
      <div><SectionTitle>Running</SectionTitle><VCard slot="running-previews"><RunningPreviews /></VCard></div>
      <div><SectionTitle>Test master</SectionTitle><VCard slot="test-master"><TestMaster /></VCard></div>
    </div>
  );
}
