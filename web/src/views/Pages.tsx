// The sidebar's other pages. Repos: one row per configured repo with its agents' numbers (a click
// opens Agents scoped to it). Usage: the analytics home — every login's windows, the limit
// forecast, spend, runs and where it went, under one range picker (views/Insights.tsx); the machine
// cards stay on the Overview. Settings: appearance, the board's density, and the configuration this bridge runs with
// (read-only — it is edited in orca.config.ts / the config table, not here).
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { FolderGit2, GitBranch } from "lucide-react";
import { densityAtom, instanceScopeAtom, repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { useTheme, type Theme } from "@/lib/theme";
import { instanceChoices, staleHours, thisInstance, useAgentProviders, useRepos, useWorkstreams } from "../store";
import { ago, repoSummaries } from "../workstream";
import { Detail, Empty, Pill, SectionTitle, Segmented, StatusDot, VCard } from "@/components/console";
import { THEMES } from "@/components/Shell";
import { UsageCard } from "./Vitals";
import { InsightRangePicker, InsightsSection } from "./Insights";
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
  const repo = useAtomValue(repoFilterAtom);
  const scope = useAtomValue(instanceScopeAtom);
  const all = instances.length ? instances : here ? [here] : [];
  const machines = scope === "all" ? all : [scope];
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
        <InsightRangePicker />
      </div>
      <UsageCard />
      <InsightsSection repo={repo === "all" ? undefined : repo} instance={scope === "all" ? undefined : scope} machines={machines} here={here} />
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
