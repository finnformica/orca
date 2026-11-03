// The GitHub rate-limit banner's facts: which budgets this bridge is blocked on, and until when
// (GitHub's reset header, confirmed by GET /rate_limit). Pure: the route builds it, the web draws it.

export type GithubLimits = {
  /** One entry per budget in force now (graphql, core, search), at its latest reset (ms). */
  limited: Array<{ resource: string; until: number }>;
};

/** The route's answer from server/github.ts `rateLimitState()`: blocks grouped by resource. */
export function githubLimits(state: { blocks: Array<{ resource: string; until: number }> }, now = Date.now()): GithubLimits {
  const by = new Map<string, number>();
  for (const b of state.blocks) if (b.until > now) by.set(b.resource, Math.max(by.get(b.resource) ?? 0, b.until));
  return { limited: [...by].map(([resource, until]) => ({ resource, until })).sort((a, b) => a.until - b.until) };
}

const NAMES: Record<string, string> = { graphql: "GraphQL", core: "REST", search: "search" };

/** The banner's text, or undefined when no budget is blocked. `time` formats a reset in the
 *  viewer's local time (HH:MM). The latest reset is the one named: until then something is stale. */
export function limitBanner(limits: GithubLimits | undefined, now: number, time: (ms: number) => string): { title: string; detail: string } | undefined {
  const live = (limits?.limited ?? []).filter((l) => l.until > now);
  if (!live.length) return undefined;
  const until = Math.max(...live.map((l) => l.until));
  const names = live.map((l) => NAMES[l.resource] ?? l.resource).join(" and ");
  return {
    title: `GitHub rate limited until ${time(until)}`,
    detail: `The ${names} budget is spent. The PR state is from the last sync; cards show its age.`,
  };
}
