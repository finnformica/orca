// Process-lifetime counters that feed /api/diagnostics. Deliberately not persisted — they measure
// *this* bridge run (how chatty polling is against GitHub), and resetting on restart is the right
// behaviour. In-memory and monotonic; the diagnostics endpoint reads them alongside the ledger.
const counters = { ghCalls: 0, agentPolls: 0, startedAt: Date.now() };

/** Calls per op (the gh.ts function that asked) and kind: what spends the GitHub budgets. A 304 is
 *  counted apart, since GitHub does not charge it. */
type OpCount = { graphql: number; rest: number; notModified: number };
const byOp = new Map<string, OpCount>();
/** One GitHub API call (every call in server/github.ts funnels through here). */
export const countGhCall = (op = "other", kind: "graphql" | "rest" = "rest", notModified = false) => {
  counters.ghCalls++;
  const c = byOp.get(op) ?? { graphql: 0, rest: 0, notModified: 0 };
  if (notModified) c.notModified++; else c[kind]++;
  byOp.set(op, c);
};
/** One `/api/agents` poll served (the store's most frequent GitHub-backed refresh). */
export const countAgentPoll = () => { counters.agentPolls++; };

export const metrics = () => ({ ...counters, uptimeMs: Date.now() - counters.startedAt, byOp: Object.fromEntries(byOp) });
