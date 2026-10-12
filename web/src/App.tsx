import { useRoute, type Route } from "@/lib/route";
import { Shell, Crumb, AddNew } from "@/components/Shell";
import { OrchestratorButton } from "@/components/Terminal";
import { useWorkstreams } from "./store";
import { NewDraft } from "./views/Board";
import { Overview } from "./views/Overview";
import { Agents } from "./views/Agents";
import { Repos, Settings, UsagePage } from "./views/Pages";
import { PreviewManagerMenu, TestMasterMenu } from "./views/PreviewControl";
import { PrDetail } from "./views/PrDetail";
import { LocalDetail } from "./views/LocalDetail";

// The console: Vercel's shell (sidebar + top bar) around one page per route. The orchestrator's
// floating launcher sits outside it, on every route.
export function App() {
  const route = useRoute();
  return (
    <>
      <Shell crumbs={<Crumbs route={route} />} actions={<TopActions route={route} />}>
        <Page route={route} />
      </Shell>
      <OrchestratorButton />
    </>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "pr": return <PrDetail repo={route.repo} number={route.number} sub={route.sub} />;
    case "local": return <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />;
    case "agents": return <Agents />;
    case "repos": return <Repos />;
    case "usage": return <UsagePage />;
    case "settings": return <Settings />;
    default: return <Overview />;
  }
}

const TITLES = { board: "Overview", agents: "Agents", repos: "Repos", usage: "Usage", settings: "Settings" } as const;

function Crumbs({ route }: { route: Route }) {
  const rows = useWorkstreams();
  if (route.name === "pr" || route.name === "local") {
    const row = route.name === "pr"
      ? rows.find((r) => r.repo === route.repo && r.prNumber === route.number)
      : rows.find((r) => r.repo === route.repo && r.branch === route.branch);
    const label = row?.title ?? (route.name === "pr" ? `#${route.number}` : route.branch);
    return <><Crumb to="/agents">Agents</Crumb><Crumb>{label}</Crumb></>;
  }
  return <Crumb>{TITLES[route.name]}</Crumb>;
}

// The page's controls, right of the breadcrumb: preview master/manager (one segmented control) and
// Vercel's "Add New" holding the New-draft box, on the pages where you start work.
function TopActions({ route }: { route: Route }) {
  if (route.name !== "board" && route.name !== "agents") return null;
  return (
    <>
      <div className="inline-flex items-center gap-0.5">
        <TestMasterMenu />
        <PreviewManagerMenu />
      </div>
      <AddNew><NewDraft /></AddNew>
    </>
  );
}

// Pure helpers the usage tests import from here (they live in lib/vitals and workstream.ts).
export { aggregateProfiles, mergeUsage } from "@/lib/vitals";
export { untilReset } from "./workstream";
