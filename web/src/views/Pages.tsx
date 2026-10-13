// The sidebar's other pages. Repos: one row per configured repo with its agents' numbers (a click
// opens Agents scoped to it). Usage: the Usage card with every login expanded, and every machine's
// card. Settings: appearance, the board's density, each machine's hourly cost (editable: the
// instance cards' Cost accrued chart), and the configuration this bridge runs with (read-only — it
// is edited in orca.config.ts / the config table, not here). Notifications: do not
// disturb, browser notifications, and which kinds pop a toast (the centre keeps every kind).
import { useEffect, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { FolderGit2, GitBranch } from "lucide-react";
import { api } from "@/api";
import { refreshVitals } from "@/lib/vitals";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { browserNotifyAtom, densityAtom, notifyDndAtom, repoFilterAtom, toastPrefsAtom } from "@/lib/atoms";
import { KIND_META, NOTIFICATION_KINDS } from "../../../shared/notifications";
import { navigate } from "@/lib/route";
import { useTheme, type Theme } from "@/lib/theme";
import { instanceChoices, staleHours, thisInstance, useAgentProviders, useRepos, useWorkstreams } from "../store";
import { ago, repoSummaries } from "../workstream";
import { Detail, Empty, Pill, SectionTitle, Segmented, StatusDot, VCard } from "@/components/console";
import { THEMES } from "@/components/Shell";
import { InstanceCard, RefreshVitals, UsageCard } from "./Vitals";
import { RunningPreviews, TestMaster } from "./PreviewControl";

export function Repos() {
  const repos = useRepos();
  const rows = useWorkstreams();
  const setRepo = useSetAtom(repoFilterAtom);
  const summaries = repoSummaries(rows, repos.map((r) => r.name));
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
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
    </div>
  );
}

const Count = ({ label, n }: { label: string; n: number }) => (
  <span className="min-w-0">
    <span className="text-muted-foreground block text-xs">{label}</span>
    <span className={`block tabular-nums ${n ? "text-foreground font-medium" : "text-muted-foreground"}`}>{n}</span>
  </span>
);

export function UsagePage() {
  useRepos();
  const here = thisInstance();
  const instances = instanceChoices();
  const machines = instances.length ? instances : here ? [here] : [];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      <UsageCard />
      <div>
        <SectionTitle aside={<RefreshVitals />}>Machines</SectionTitle>
        <div className="space-y-4">{machines.map((m) => <InstanceCard key={m} instance={m} here={m === here || !instances.length} />)}</div>
      </div>
    </div>
  );
}

export function Settings() {
  const [theme, setTheme] = useTheme();
  const [density, setDensity] = useAtom(densityAtom);
  const repos = useRepos();
  const providers = useAgentProviders();
  const here = thisInstance();
  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <VCard slot="settings-appearance" title="Appearance" bodyClass="divide-y">
        <Setting label="Theme" hint="Light, dark, or follow the system.">
          <Segmented label="Theme" value={theme} onChange={(v) => setTheme(v as Theme)} options={THEMES.map((t) => ({ value: t.value, label: t.label }))} />
        </Setting>
        <Setting label="Board density" hint="The Board view's cards: full, or status only.">
          <Segmented label="Density" value={density} onChange={setDensity} options={[{ value: "comfortable", label: "Comfortable" }, { value: "dense", label: "Dense" }]} />
        </Setting>
      </VCard>
      <NotificationSettings />
      <MachineCostSettings />
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

function NotificationSettings() {
  const [dnd, setDnd] = useAtom(notifyDndAtom);
  const [browser, setBrowser] = useAtom(browserNotifyAtom);
  const [prefs, setPrefs] = useAtom(toastPrefsAtom);
  const onOff = [{ value: "on", label: "On" }, { value: "off", label: "Off" }];
  const enableBrowser = async (on: boolean) => {
    // The permission is asked for when switched on; refused, the switch stays off.
    if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const r = await Notification.requestPermission().catch(() => "denied");
      if (r !== "granted") return setBrowser(false);
    }
    setBrowser(on);
  };
  return (
    <VCard slot="settings-notifications" title="Notifications" bodyClass="divide-y">
      <Setting label="Do not disturb" hint="Silence the toasts; the centre still collects everything.">
        <Segmented label="Do not disturb" value={dnd ? "on" : "off"} onChange={(v) => setDnd(v === "on")} options={onOff} />
      </Setting>
      <Setting label="Browser notifications" hint="When this tab is hidden: an agent needing input, a failure, a failed check.">
        <Segmented label="Browser notifications" value={browser ? "on" : "off"} onChange={(v) => void enableBrowser(v === "on")} options={onOff} />
      </Setting>
      <div className="px-4 py-3">
        <div className="text-sm font-medium">Toasts</div>
        <div className="text-muted-foreground mb-2 text-xs">Which kinds pop up in the corner.</div>
        <ul data-slot="notification-kinds" className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {NOTIFICATION_KINDS.map((k) => (
            <li key={k}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-geist-blue" checked={prefs[k] !== false} onChange={(e) => setPrefs({ ...prefs, [k]: e.target.checked })} />
                {KIND_META[k].label}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </VCard>
  );
}

/** Each machine's USD/hour — `instanceHourlyUsd` in the app config, what its card's Cost accrued
 *  chart accrues. Empty means automatic: an EC2 on-demand estimate, else 0. */
function MachineCostSettings() {
  const here = thisInstance();
  const machines = instanceChoices().length ? instanceChoices() : here ? [here] : [];
  const [rates, setRates] = useState<Record<string, number> | null>(null);
  useEffect(() => { api.config().then((c) => setRates(c.instanceHourlyUsd ?? {}), () => setRates({})); }, []);
  if (!machines.length) return null;
  return (
    <VCard slot="settings-machine-cost" title="Machine cost" bodyClass="divide-y">
      {machines.map((m) => <MachineRate key={m} instance={m} saved={rates?.[m]} loaded={rates !== null}
        onSaved={(v) => setRates((r) => { const next = { ...r }; if (v === null) delete next[m]; else next[m] = v; return next; })} />)}
    </VCard>
  );
}

function MachineRate({ instance, saved, loaded, onSaved }: { instance: string; saved: number | undefined; loaded: boolean; onSaved: (v: number | null) => void }) {
  const [text, setText] = useState("");
  useEffect(() => { setText(saved === undefined ? "" : String(saved)); }, [saved, loaded]);
  const [busy, setBusy] = useState(false);
  const value = text.trim() === "" ? null : Number(text);
  const valid = value === null || (Number.isFinite(value) && value >= 0);
  const dirty = (saved ?? null) !== value;
  const save = async () => {
    setBusy(true);
    try { await api.setInstanceRate(instance, value); onSaved(value); void refreshVitals(); }
    catch (e) { toast({ kind: "error", title: `Save rate failed · ${instance}`, body: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return (
    <Setting label={instance} hint="USD per hour. Empty: an EC2 on-demand estimate, else 0.">
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (valid && dirty) void save(); }}>
        <span className="text-muted-foreground text-sm">$</span>
        <input data-slot="machine-rate" aria-label={`${instance} USD per hour`} inputMode="decimal" placeholder="auto" value={text} disabled={!loaded}
          onChange={(e) => setText(e.target.value)} aria-invalid={!valid}
          className="border-input bg-background h-8 w-24 rounded-md border px-2 text-sm tabular-nums" />
        <span className="text-muted-foreground text-sm">/h</span>
        <Button type="submit" variant="secondary" size="sm" disabled={!valid || !dirty || busy}>Save</Button>
      </form>
    </Setting>
  );
}

const Setting = ({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 px-4 py-3">
    <div><div className="text-sm font-medium">{label}</div><div className="text-muted-foreground text-xs">{hint}</div></div>
    {children}
  </div>
);

/** Previews: every live preview across instances (Open / Stop), and Test master — a preview of each
 *  repo's base branch. The sidebar's Previews item carries the badges (running count, base preview). */
export function PreviewsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Previews</h1>
      <div><SectionTitle>Running</SectionTitle><VCard slot="running-previews"><RunningPreviews /></VCard></div>
      <div><SectionTitle>Test master</SectionTitle><VCard slot="test-master"><TestMaster /></VCard></div>
    </div>
  );
}
