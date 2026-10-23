// A throwaway harness, not linked from the app and not part of `vite build`'s default entry (only
// index.html is): it renders the REAL chat panel (views/Chat.tsx ChatPanel) with no bridge behind
// it, for orca-shot screenshots of a quote in a conversation — a feature the read-only preview
// bridge cannot show (it refuses every write route, so there is no way to seed a turn through it).
// api.turnPage is the one call the panel needs answered; everything else it tries (the live stream,
// queued messages) fails silently against a page with no backend, exactly as it would offline.
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./lib/theme"; // applies the OS theme, so `orca-shot --dark` shows the dark card
import { api } from "@/api";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import type { AgentTurn } from "../../shared/agent";

const row: Row = {
  repo: "demo", hasRemote: true, branch: "fix-admin-access", title: "Fix admin access bug",
  prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/demo", agentProvider: "claude",
};

const turn: AgentTurn = {
  id: "run-1",
  provider: "claude",
  instruction: "please check this, if you can look at the db logs as well:\n\n> I'm getting an error when trying to promote a user to Admin for Starcatcher. I've noticed that they have the same issue the Harbinger had, where I'm also not able to change the user from \"4 Projects\" access to \"All 4 Projects\" access.",
  prompt: "",
  response: "Found it after checking the logs:\n\n> the Starcatcher org fails the same permission check as Harbinger — both compare the project list by name instead of id.\n\nFixed now; both orgs promote correctly.",
  finishedAt: Date.now(),
};

api.turnPage = async () => ({ turns: [turn], older: null });

createRoot(document.getElementById("root")!).render(
  <div className="bg-background flex min-h-screen items-center justify-center p-6">
    <div className="bg-card text-foreground h-[80vh] w-[90vw] max-w-2xl overflow-hidden rounded-lg border">
      <ChatPanel row={row} />
    </div>
  </div>,
);
