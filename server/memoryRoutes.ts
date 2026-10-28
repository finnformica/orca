// The Memory page's API (docs/design/named-agents-and-memory.md §9). Postgres only, so any instance
// answers; never forwarded. Every change here is the USER's (server/memory.ts `USER`): pin, mark
// trusted and revert exist only on this path, never as an `orca` verb.
import * as agents from "./agents";
import * as db from "./db";
import * as memory from "./memory";
import * as scheduledWake from "./scheduledWake";
import { MEMORY_BUDGET, MEMORY_LIMITS, filterMemories, parseMemoryQuery, type MemoryState } from "../shared/memory";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const tags = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : undefined);

/** Answer a /api/memory request, or undefined when the path is not one. */
export async function handleMemory(req: Request, url: URL, body: Record<string, unknown>): Promise<Response | undefined> {
  const p = url.pathname;
  if (p !== "/api/memory" && !p.startsWith("/api/memory/")) return undefined;
  try {
    if (req.method === "GET" && p === "/api/memory") {
      const q = parseMemoryQuery(url.search);
      const now = Date.now();
      const [all, today, owners] = await Promise.all([memory.listForPage({ text: q.q, states: q.states }), memory.changesToday(now), memory.owners()]);
      return json({ memories: filterMemories(all, q, now), today, owners, limits: { perDay: MEMORY_LIMITS.perDay } });
    }
    if (req.method === "GET" && p === "/api/memory/reflections") return json({ passes: await memory.passes({ ...(url.searchParams.get("agent") ? { agent: url.searchParams.get("agent")! } : {}) }) });
    if (req.method === "GET" && p === "/api/memory/activity") return json({ revisions: await memory.activity(num(url.searchParams.get("limit")) ?? 200) });
    if (req.method === "GET" && p === "/api/memory/core") {
      const c = await memory.core(url.searchParams.get("agent") || (await agents.defaultAgent()).name);
      return json({ ...c, budget: MEMORY_BUDGET.coreTokens, pinnedWarn: MEMORY_BUDGET.pinnedWarnTokens });
    }
    if (req.method === "POST" && p === "/api/memory") {
      const m = await memory.write({
        owner: str(body.owner) ?? "shared", title: str(body.title) ?? "", body: str(body.body) ?? "",
        tags: tags(body.tags), importance: num(body.importance), reason: str(body.reason) ?? "written by the user",
      }, { kind: "user" });
      return json({ memory: m });
    }
    const m = p.match(/^\/api\/memory\/(\d+)$/);
    if (!m) return json({ error: "not found" }, 404);
    const id = Number(m[1]);
    if (req.method === "GET") {
      const one = await memory.get(id);
      if (!one) return json({ error: `no memory m${id}` }, 404);
      const [links, revisions, wakes] = await Promise.all([memory.links(id), memory.revisions(id), scheduledWake.list({ memoryId: id, all: true })]);
      return json({ memory: one, links, revisions, wakes });
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const reason = str(body.reason);
    switch (body.action) {
      case "edit": return json({ memory: await memory.userEdit(id, { title: str(body.title), body: str(body.body), tags: tags(body.tags), importance: num(body.importance), owner: str(body.owner) }, reason) });
      case "pin": return json({ memory: await memory.pin(id, true, reason) });
      case "unpin": return json({ memory: await memory.pin(id, false, reason) });
      case "trust": return json({ memory: await memory.markTrusted(id, reason) });
      case "state": {
        const state = str(body.state) as MemoryState | undefined;
        if (state !== "active" && state !== "archived" && state !== "forgotten") return json({ error: "state must be active, archived or forgotten" }, 400);
        return json({ memory: await memory.userEdit(id, { state }, reason ?? (state === "active" ? "restored by the user" : `${state} by the user`)) });
      }
      case "revert": {
        const revision = num(body.revision);
        if (!revision) return json({ error: "revision required" }, 400);
        return json({ memory: await memory.revert(id, revision) });
      }
      default: return json({ error: "action must be edit, pin, unpin, trust, state or revert" }, 400);
    }
  } catch (e) {
    if (e instanceof memory.MemoryError) return json({ error: e.message }, e.status);
    if (e instanceof db.DbUnavailable) return json({ error: "database unreachable", dbUnavailable: true }, 503);
    throw e;
  }
}
