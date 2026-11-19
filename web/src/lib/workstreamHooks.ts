// Hooks that the Agents list and the agent page share for one workstream row.
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { ChangeSummary } from "../../../server/git";
import { openTerminalAtom } from "./atoms";
import { useQuery } from "@tanstack/react-query";
import { queryClient, useRefetchOnChange } from "./queryClient";
import { summary as fetchSummary, type Row } from "../store";

// Diffstat for every lane except Done (needs a worktree — Orca-made PRs keep theirs; adopted PRs
// gain one on first action). Fetched once, and polled only while its agent runs. Shared by the
// Agents list's row and the PR page.
// A query in the app's QueryClient (lib/queryClient.ts), so the Agents list shows every row's diffstat
// at once when you come back to it; an idle row's is not fetched again for SUMMARY_FRESH_MS.
export function useSummary(row: Row | undefined): ChangeSummary | null {
  const isDone = row?.lane === "DONE";
  const repo = row?.repo, wt = row?.worktreePath, base = row?.prBase, status = row?.agentStatus;
  return useChangeSummary(isDone || !repo || !wt ? null : { repo, wt, base, status });
}

/** One worktree's diffstat. Polled while its agent runs; a new run status fetches it again at once
 *  (a run that just finished has new commits). */
export const SUMMARY_FRESH_MS = 30_000;
export function useChangeSummary(of: { repo: string; wt: string; base?: string; status?: string } | null): ChangeSummary | null {
  const running = of?.status === "running";
  const { data, refetch } = useQuery({
    queryKey: ["summary", of?.repo, of?.wt, of?.base ?? ""],
    queryFn: () => fetchSummary(of!.repo, of!.wt, of!.base),
    enabled: Boolean(of),
    staleTime: running ? 0 : SUMMARY_FRESH_MS,
    refetchInterval: running ? 8000 : false,
  }, queryClient);
  useRefetchOnChange(refetch, of?.status, Boolean(of));
  return data ?? null;
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
