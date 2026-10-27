// A throwaway harness, not linked from the app and not part of `vite build`'s default entry (only
// index.html is): it renders the REAL chat panel (views/Chat.tsx ChatPanel) with no bridge behind
// it, for orca-shot screenshots of chat states a read-only preview bridge cannot show (it refuses
// every write route, so there is no way to seed a turn, or launch an agent, through it).
// api.turnPage is the one call the panel needs answered; everything else it tries (the live stream,
// queued messages) fails silently against a page with no backend, exactly as it would offline.
// `?view=` picks the state to render: "quote" (default, PR #430) — a finished turn with a quote in
// both the user's own bubble and the agent's reply; "working" — a live turn with no response yet,
// for the spinner on its status line; "sending" — a `send` prop that never resolves, so typing a
// message into the composer and pressing Enter leaves it in the "sending…" state; "slash" — a worker
// chat with a PR, for the composer's `/` menu; "orchestrator" — the orchestrator's chat; "chips" —
// a sent message with an image and a secret chip, and a composer draft seeded with both (an image
// drawn here, a secret NAME only), whose send is held open like "sending".
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./lib/theme"; // applies the OS theme, so `orca-shot --dark` shows the dark card
import { api } from "@/api";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { ORCHESTRATOR_BRANCH, ORCHESTRATOR_REPO } from "@/workstream";
import type { AgentTurn } from "../../shared/agent";

const view = new URLSearchParams(location.search).get("view") ?? "quote";

const row: Row = view === "orchestrator" ? {
  repo: ORCHESTRATOR_REPO, hasRemote: false, branch: ORCHESTRATOR_BRANCH, title: "Orca", prompt: "", lane: "LOCAL", worktreePath: "/state/orchestrator", agentStatus: "idle",
} : {
  repo: "demo", hasRemote: true, branch: "fix-admin-access", title: "Fix admin access bug",
  prompt: "", lane: "IN_REVIEW", worktreePath: "/wt/demo", agentProvider: "claude", ...(view === "slash" && { prNumber: 7 }),
};

const quoteTurn: AgentTurn = {
  id: "run-1",
  provider: "claude",
  instruction: "please check this, if you can look at the db logs as well:\n\n> I'm getting an error when trying to promote a user to Admin for Starcatcher. I've noticed that they have the same issue the Harbinger had, where I'm also not able to change the user from \"4 Projects\" access to \"All 4 Projects\" access.",
  prompt: "",
  response: "Found it after checking the logs:\n\n> the Starcatcher org fails the same permission check as Harbinger — both compare the project list by name instead of id.\n\nFixed now; both orgs promote correctly.",
  finishedAt: Date.now(),
};

const workingTurn: AgentTurn = {
  id: "run-2", provider: "claude", instruction: "fix the Starcatcher permission bug", prompt: "", response: "",
};

const SHOT_ID = "00000000-0000-4000-8000-000000000001";
const chipsTurn: AgentTurn = {
  id: "run-3", provider: "claude", prompt: "", finishedAt: Date.now(),
  instruction: "deploy the worker with this key\n\n[secret chat/stripe_key stored]",
  attachments: [{ id: SHOT_ID, name: "error.png" }],
  response: "Deployed. The worker reads the key from the secret store.",
};
if (view === "chips") {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 120;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0070f3"; g.fillRect(0, 0, 160, 120);
  g.fillStyle = "#fff"; g.font = "bold 28px sans-serif"; g.fillText("shot", 46, 70);
  localStorage.setItem(`orca.chat.${row.repo}::${row.branch}`, JSON.stringify({
    text: "use this key for the staging deploy",
    images: [{ name: "screen.png", type: "image/png", dataUrl: c.toDataURL("image/png") }],
    secrets: ["chat/stripe_key"],
  }));
}

api.turnPage = async () => ({ turns: [view === "working" ? workingTurn : view === "chips" ? chipsTurn : quoteTurn], older: null });

const send = view === "sending" || view === "chips" ? () => new Promise<void>(() => {}) : undefined; // held open forever

createRoot(document.getElementById("root")!).render(
  <div className="bg-background flex min-h-screen items-center justify-center p-6">
    <div className="bg-card text-foreground h-[80vh] w-[90vw] max-w-2xl overflow-hidden rounded-lg border">
      <ChatPanel row={row} send={send} author={view === "orchestrator" ? "Orca" : undefined} />
    </div>
  </div>,
);
