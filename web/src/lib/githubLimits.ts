// The GitHub rate-limit banner's data (server/github.ts `rateLimitState`, via /api/github/limits):
// one shared poll while a banner is mounted, like lib/handoffBadge.ts. It costs no GitHub call: the
// bridge answers from what its last calls were told.
import { useSyncExternalStore } from "react";
import { api } from "../api";
import { poll } from "./poll";
import type { GithubLimits } from "../../../shared/githubLimits";

let limits: GithubLimits | undefined;
let stop: (() => void) | undefined;
const subs = new Set<() => void>();
const fetchLimits = () => api.githubLimits().then((v) => { limits = v; subs.forEach((s) => s()); });

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) stop = poll(fetchLimits, 30_000);
  return () => {
    subs.delete(cb);
    if (!subs.size) { stop?.(); stop = undefined; }
  };
}

/** The budgets this bridge is blocked on now (undefined until the first answer). */
export const useGithubLimits = (): GithubLimits | undefined => useSyncExternalStore(subscribe, () => limits);
