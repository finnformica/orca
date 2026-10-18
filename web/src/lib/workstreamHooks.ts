// Hooks that the Agents list and the agent page share for one workstream row.
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { ChangeSummary } from "../../../server/git";
import { openTerminalAtom } from "./atoms";
import { poll } from "./poll";
import { summary as fetchSummary, type Row } from "../store";

// Diffstat for every lane except Done (needs a worktree — Orca-made PRs keep theirs; adopted PRs
// gain one on first action). Fetched once, and polled only while its agent runs. Shared by the
// Agents list's row and the PR page.
export function useSummary(row: Row | undefined): ChangeSummary | null {
  const isDone = row?.lane === "DONE";
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  const repo = row?.repo, wt = row?.worktreePath, base = row?.prBase, status = row?.agentStatus;
  useEffect(() => {
    if (isDone || !repo || !wt) return;
    const reload = () => fetchSummary(repo, wt, base).then(setSummary).catch(() => {});
    if (status !== "running") return void reload();
    return poll(reload, 8000);
  }, [isDone, repo, wt, base, status]);
  return summary;
}

// The conversation opens in a terminal-style modal from the Agents row (no navigating to the detail
// page). A workstream born from "New chat" opens its terminal on arrival (see openTerminalAtom).
export function useTerminalOpen(row: Row): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useAtom(openTerminalAtom);
  useEffect(() => {
    if (wanted !== `${row.repo}::${row.branch}`) return;
    setOpen(true);
    setWanted(null);
  }, [wanted, row.repo, row.branch, setWanted]);
  return [open, setOpen];
}
