import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { navigate, useRoute, type Route } from "@/lib/route";
import { addNewOpenAtom } from "@/lib/atoms";
import { openOrchestrator } from "@/lib/orchestratorOpen";
import { launchOverlay } from "./workstream";
import { expandTruncatedOnTap, trackVisualViewport } from "@/lib/viewport";
import { Shell, Crumb, AddNew } from "@/components/Shell";
import { OrchestratorPanel, OrchestratorPage, OrchestratorWindow, isOrchestratorWindow } from "@/components/Terminal";
import { TerminalPanel } from "@/components/InstanceTerminal";
import { ToastHost } from "@/components/Notifications";
import { useShowBoard, useWorkstreams } from "./store";
import { NewDraft } from "./views/NewDraft";
import { Overview } from "./views/Overview";
import { Agents } from "./views/Agents";
import { BoardPage } from "./views/Board";
import { InboxPage } from "./views/Inbox";
import { PreviewsPage, Settings } from "./views/Pages";
import { HandoffsPage } from "./views/Handoffs";
import { PrDetail } from "./views/PrDetail";
import { IntegrationsPage } from "./views/Integrations";
import { LocalDetail } from "./views/LocalDetail";
import { TooltipProvider } from "./components/ui/tooltip";

// The console: Vercel's shell (sidebar + top bar) around one page per route. The orchestrator's
// window floats outside it, on every route; the top bar's "Ask the orchestrator" opens it. Action
// failures are notifications (lib/notificationStore `actionFailed`), in the one toast stack.
export function App() {
  const route = useRoute();
  // The phone layout's two global listeners: the visible viewport's size (sheets stay above the
  // keyboard) and tap-to-expand for truncated text.
  useEffect(() => { const a = trackVisualViewport(), b = expandTruncatedOnTap(); return () => { a(); b(); }; }, []);
  // A home-screen shortcut (manifest `shortcuts`) launches with ?open=new|orchestrator: open that
  // overlay once, and drop the parameter so a reload doesn't reopen it.
  const setAddNew = useSetAtom(addNewOpenAtom);
  // The plain function, NOT useOrchestrator(): that subscribes to the open atom, and App re-rendering
  // re-renders the whole page (measured: the Overview's charts and feed in every panel open / close).
  const ask = openOrchestrator;
  useEffect(() => {
    const open = launchOverlay(location.search);
    if (!open) return;
    navigate(location.pathname, true);
    if (open === "new") setAddNew(true); else ask();
  }, []);
  // Pop out's popup window (no Document PiP in this browser): the chat alone, no shell around it.
  if (route.name === "orchestrator" && isOrchestratorWindow()) return <TooltipProvider><OrchestratorWindow /></TooltipProvider>;
  return (
    <TooltipProvider>
      <Shell crumbs={<Crumbs route={route} />} sidebarActions={(collapsed) => <SidebarAction collapsed={collapsed} />}>
        <Page route={route} />
      </Shell>
      <ToastHost />
      <OrchestratorPanel />
      <TerminalPanel />
    </TooltipProvider>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "pr": return <PrDetail repo={route.repo} number={route.number} sub={route.sub} />;
    case "local": return <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />;
    case "agents": return <Agents />;
    case "board": return <BoardRoute />;
    case "inbox": return <InboxPage />;
    case "previews": return <PreviewsPage />;
    case "handoffs": return <HandoffsPage />;
    case "settings": return <Settings />;
    case "integrations": return <IntegrationsPage />;
    // The orchestrator's routed page (narrow screens; see useOrchestrator). It works if visited
    // directly on a desktop width too — nothing about the route itself is phone-only.
    case "orchestrator": return <OrchestratorPage />;
    default: return <Overview />;
  }
}

// The Board view while Settings shows it; with it off, a board URL is replaced by the Agents view.
function BoardRoute() {
  const show = useShowBoard();
  useEffect(() => { if (!show) navigate("/agents", true); }, [show]);
  return show ? <BoardPage /> : <Agents />;
}

const TITLES = { overview: "Overview", agents: "Agents", board: "Board", inbox: "Inbox", previews: "Previews", handoffs: "Handoffs", settings: "Settings", orchestrator: "Orchestrator", integrations: "Integrations" } as const;

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

// The last of the sidebar's actions: Vercel's "Add New", opening the New-draft box in a dialog.
const SidebarAction = ({ collapsed }: { collapsed: boolean }) => (
  <AddNew collapsed={collapsed}>{(onSent) => <NewDraft onSent={onSent} autoFocus />}</AddNew>
);

// Pure helpers the usage tests import from here (they live in lib/vitals and workstream.ts).
export { aggregateProfiles, headerUsage, mergeUsage } from "@/lib/vitals";
export { untilReset } from "./workstream";
