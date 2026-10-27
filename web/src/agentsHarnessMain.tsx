// A throwaway harness, not linked from the app and not part of `vite build`'s default entry (only
// index.html is): it renders the REAL Settings > Agents section (views/AgentSettings.tsx) with the
// two seeded rows and one user-added agent, for orca-shot screenshots. A read-only preview bridge
// cannot show it: the shared database has no agent-definitions step until the PR merges.
// `?edit=<name>` opens that agent's editor.
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import "./styles.css";
import "./lib/theme"; // applies the OS theme, so `orca-shot --dark` shows the dark card
import { api } from "@/api";
import { AgentsSettings } from "@/views/AgentSettings";
import { AGENT_VERBS, type AgentDef } from "../../shared/agents";

const defs: AgentDef[] = [
  { name: "chief", displayName: "Chief of Staff", branch: "orchestrator", role: "You are Orca's orchestrator. The user talks only to you. You get work done by delegating to worker\nagents: each is a headless coding agent in its own git worktree…", model: "claude-opus-5-5", tools: { shell: true, verbs: "all" }, maxGrant: "full", state: "idle", builtin: true },
  { name: "assistant", displayName: "Assistant", branch: "assistant", role: "You are Orca's Assistant, one of a small team of named agents. The Chief of Staff (`chief`) runs the\nteam…", model: "claude-sonnet-5-5", tools: { shell: false, verbs: ["board", "channels", "machine", "chats", "read", "post", "thread", "ask-user", "ask-form", "memory", "wake", "ask", "agent", "status", "preview", "slack", "gmail", "cloudflare"] }, maxGrant: "full", state: "idle", builtin: true },
  { name: "scout", displayName: "Scout", branch: "scout", role: "Read the board each morning and tell the Chief of Staff what is stuck.", tools: { shell: false, verbs: ["board", "read", "ask"] }, maxGrant: "full", state: "idle", builtin: false },
];
api.agentDefs = async () => ({ agents: defs, verbs: [...AGENT_VERBS] });

function Harness() {
  // Open the editor the URL names, with a real click on its Edit button.
  useEffect(() => {
    const edit = new URLSearchParams(location.search).get("edit");
    if (!edit) return;
    const t = setInterval(() => {
      const b = document.querySelector<HTMLButtonElement>(`[data-agent="${edit}"] [data-slot="agent-edit"]`);
      if (b) { b.click(); clearInterval(t); }
    }, 50);
    return () => clearInterval(t);
  }, []);
  return <div className="bg-background min-h-screen p-6"><div className="mx-auto max-w-4xl"><AgentsSettings /></div></div>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
