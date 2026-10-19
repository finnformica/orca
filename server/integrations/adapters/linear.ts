// The Linear adapter (docs/research/integrations.md §5 and phase 7; setup: docs/integrations/linear.md).
// Inbound is a poll on the GraphQL API with the API key in the integration's secret (ORCA_SECRET_LINEAR):
// every `pollSeconds` it reads the issues and comments updated since the cursor (an `updatedAt`, stored
// in integration_cursor). An issue assigned to the configured user, or whose description mentions
// them, is ONE event; a comment by someone else on such an issue, or one that mentions them, is one
// more. All are `ext.linear.message` in the issue's thread (externalId = the issue id; messageId = the
// top-level comment, so a reply lands under it), so the core routes them to the orchestrator. The
// place is the issue's project (`project:<id>`), then its team (`team:<KEY>`), then the `*` link. No
// actor: a poller is a machine sender, so the link's level is the grant (ADAPTERS.md §4) and nobody
// is asked to pair; `display` names the person and the issue for the activity row. The user's own
// comments are skipped — Orca posts with the same key, so its own comments never come back in.
// Outbound: a delivery with a thread (the issue an event came from, or one linked to a workstream
// with `orca thread link linear <issue id>`) becomes a comment on that issue, as the key's user;
// `replyToExternalMsgId` makes it a reply under that comment. A delivery with no issue is skipped.
// Agent-app mode (Linear's agent sessions, `actor=app`) needs a webhook through a relay: not here.
import { createHash } from "crypto";
import type { Adapter, AdapterContext, Connection } from "../adapter";
import type { Capabilities, InboundEnvelope, OutboundMessage, SendResult, Target } from "../../../shared/integrations";

export const LINEAR_API = "https://api.linear.app/graphql";
export const DEFAULT_POLL_SECONDS = 60;
const PAGE = 50;
const MAX_PAGES = 10; // 500 rows a poll; the rest comes next poll (the cursor only moves past what was read)
const DESCRIPTION_MAX = 4_000;

// No `rate`: the core paces per link, and one team link holds many issues. Linear's limit is per
// hour; a RATELIMITED answer returns `retryAfterMs`, so the core backs off.
export const LINEAR_CAPS: Capabilities = {
  inbound: "poll", outbound: true, threads: true, edits: true, reactions: false, attachments: false, maxTextLength: 50_000,
};

export type LinearUser = { id: string; name: string; displayName?: string };
export type LinearIssue = {
  id: string; identifier: string; title: string; description?: string | null; url: string; updatedAt: string; createdAt?: string;
  assignee?: { id: string; name?: string } | null; creator?: { id: string; name?: string; displayName?: string } | null;
  state?: { name: string } | null; team: { id: string; key: string }; project?: { id: string; name: string } | null;
};
export type LinearComment = {
  id: string; body: string; url?: string; createdAt: string; updatedAt: string;
  user?: { id: string; name?: string; displayName?: string } | null; parent?: { id: string } | null; issue: LinearIssue;
};

type GqlResult<T> = { ok: true; data: T } | { ok: false; retryable: boolean; retryAfterMs?: number; error: string };

/** One GraphQL call. Never throws. A personal API key goes in `authorization` as is (no Bearer). */
export async function linearRequest<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
  let res: Response;
  try {
    res = await fetch(LINEAR_API, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify({ query, variables }) });
  } catch (e) {
    return { ok: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
  }
  const retry = Number(res.headers.get("retry-after"));
  const retryAfterMs = retry > 0 ? retry * 1000 : undefined;
  const body = (await res.json().catch(() => undefined)) as { data?: T; errors?: { message?: string; extensions?: { code?: string; type?: string } }[] } | undefined;
  const err = body?.errors?.[0];
  const code = String(err?.extensions?.code ?? "").toUpperCase(), type = String(err?.extensions?.type ?? "").toLowerCase();
  if (res.status === 429 || code === "RATELIMITED") return { ok: false, retryable: true, retryAfterMs: retryAfterMs ?? 60_000, error: "rate limited" };
  if (res.status === 401 || res.status === 403 || code === "AUTHENTICATION_ERROR" || type.includes("authentication")) return { ok: false, retryable: false, error: `authentication failed: ${err?.message ?? `http ${res.status}`}` };
  if (res.status >= 500) return { ok: false, retryable: true, ...(retryAfterMs ? { retryAfterMs } : {}), error: `http ${res.status}` };
  if (err) return { ok: false, retryable: false, error: err.message ?? "GraphQL error" };
  if (!res.ok || !body?.data) return { ok: false, retryable: false, error: `http ${res.status}` };
  return { ok: true, data: body.data };
}

// ── Queries ──────────────────────────────────────────────────────────────────────────────────────

const ISSUE_FIELDS = `id identifier title description url updatedAt createdAt assignee { id name } creator { id name displayName } state { name } team { id key } project { id name }`;
export const VIEWER_QUERY = `query OrcaViewer { viewer { id name displayName } }`;
export const USER_QUERY = `query OrcaUser($id: String!) { user(id: $id) { id name displayName } }`;
export const ISSUES_QUERY = `query OrcaIssues($filter: IssueFilter!, $after: String) {
  issues(first: ${PAGE}, after: $after, orderBy: updatedAt, filter: $filter) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } }
}`;
export const COMMENTS_QUERY = `query OrcaComments($filter: CommentFilter!, $after: String) {
  comments(first: ${PAGE}, after: $after, orderBy: updatedAt, filter: $filter) { nodes { id body url createdAt updatedAt user { id name displayName } parent { id } issue { ${ISSUE_FIELDS} } } pageInfo { hasNextPage endCursor } }
}`;
export const COMMENT_CREATE = `mutation OrcaCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`;
export const COMMENT_UPDATE = `mutation OrcaCommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success comment { id url } } }`;

/** The server-side filters. The adapter checks the same rules again on each row (`issueReason`,
 *  `commentWanted`), so a filter Linear reads more loosely costs a row, never a wrong event. */
export const issueFilter = (since: string, me: LinearUser) => ({
  updatedAt: { gt: since },
  or: [{ assignee: { id: { eq: me.id } } }, ...mentionTokens(me).map((t) => ({ description: { containsIgnoreCase: t } }))],
});
export const commentFilter = (since: string, me: LinearUser) => ({
  updatedAt: { gt: since },
  user: { id: { neq: me.id } },
  or: [{ issue: { assignee: { id: { eq: me.id } } } }, ...mentionTokens(me).map((t) => ({ body: { containsIgnoreCase: t } }))],
});

// ── Pure decisions ───────────────────────────────────────────────────────────────────────────────

/** The text forms of a mention of `me`: `@name` (the markdown Linear stores) and the profile link. */
export function mentionTokens(me: LinearUser): string[] {
  const names = [...new Set([me.displayName, me.name].filter((n): n is string => !!n && !/\s/.test(n)))];
  return names.flatMap((n) => [`@${n}`, `/profiles/${n}`]);
}

export function mentions(text: string | null | undefined, me: LinearUser): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return mentionTokens(me).some((t) => {
    const i = lower.indexOf(t.toLowerCase());
    if (i < 0) return false;
    const next = lower[i + t.length];
    return next === undefined || !/[a-z0-9_.-]/.test(next) || (next === "." && !/[a-z0-9]/.test(lower[i + t.length + 1] ?? ""));
  });
}

/** Why an issue is an event for `me`, or undefined. */
export const issueReason = (i: LinearIssue, me: LinearUser): "assigned" | "mention" | undefined =>
  i.assignee?.id === me.id ? "assigned" : mentions(i.description, me) ? "mention" : undefined;

/** A comment is an event when someone else wrote it on an issue assigned to `me`, or it mentions `me`. */
export const commentWanted = (c: LinearComment, me: LinearUser): boolean =>
  c.user?.id !== me.id && (c.issue.assignee?.id === me.id || mentions(c.body, me));

/** Where an issue lives, for the link: its project first, then its team. */
export function places(i: Pick<LinearIssue, "team" | "project">): { channel: string; parents: string[] } {
  const team = `team:${i.team.key}`;
  return i.project ? { channel: `project:${i.project.id}`, parents: [team] } : { channel: team, parents: [] };
}

const clipText = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max - 1)}…`);
const issueLine = (i: LinearIssue) => [`Team ${i.team.key}`, i.project ? `Project ${i.project.name}` : "", i.state ? `State ${i.state.name}` : ""].filter(Boolean).join(" · ");

/** The issue as a place a person reads: "ENG-12 Fix the login page". */
export const issuePlace = (i: Pick<LinearIssue, "identifier" | "title">): string => `${i.identifier} ${i.title}`;

export function issueEnvelope(connectionId: string, i: LinearIssue, reason: "assigned" | "mention", me: LinearUser): InboundEnvelope {
  const where = places(i);
  const sender = i.creator?.displayName ?? i.creator?.name;
  return {
    // One event per issue and reason: a later edit of the issue is not news.
    key: `linear:${connectionId}:issue:${i.id}:${reason}`,
    topic: "ext.linear.message",
    at: Date.parse(i.updatedAt) || Date.now(),
    source: { adapter: "linear", integrationId: connectionId, channel: where.channel, ...(where.parents.length ? { parents: where.parents } : {}) },
    thread: { adapter: "linear", externalId: i.id },
    // Assigned to the user, or about them: as direct as a mention.
    mentioned: true,
    display: { ...(sender ? { sender } : {}), place: issuePlace(i) },
    title: issuePlace(i),
    text: [
      // The first line is the activity row's preview.
      reason === "assigned" ? `Assigned to ${me.name}: ${i.title}` : `Mentioned ${me.name} in ${i.identifier}: ${i.title}`,
      ...(i.description?.trim() ? ["", clipText(i.description.trim(), DESCRIPTION_MAX)] : []),
      "",
      `Linear issue ${i.identifier} (${issueLine(i)}${sender ? ` · opened by ${sender}` : ""}). Issue id for orca thread link linear: ${i.id}`,
    ].join("\n"),
    link: { url: i.url },
    raw: { issue: i.id, identifier: i.identifier, reason },
  };
}

export function commentEnvelope(connectionId: string, c: LinearComment, me: LinearUser): InboundEnvelope {
  const i = c.issue, where = places(i);
  const author = c.user?.displayName ?? c.user?.name ?? "someone";
  return {
    key: `linear:${connectionId}:comment:${c.id}`,
    topic: "ext.linear.message",
    at: Date.parse(c.createdAt) || Date.now(),
    source: { adapter: "linear", integrationId: connectionId, channel: where.channel, ...(where.parents.length ? { parents: where.parents } : {}) },
    // Linear nests one level: a reply goes under the top-level comment, never under a reply.
    thread: { adapter: "linear", externalId: i.id, messageId: c.parent?.id ?? c.id },
    mentioned: mentions(c.body, me),
    display: { sender: author, place: issuePlace(i) },
    title: `${author} on ${issuePlace(i)}`,
    text: `${clipText(c.body.trim(), DESCRIPTION_MAX)}\n\n${author} commented on Linear issue ${i.identifier} "${i.title}" (${issueLine(i)}). Issue id for orca thread link linear: ${i.id}`,
    link: { url: c.url ?? i.url },
    raw: { comment: c.id, issue: i.id, identifier: i.identifier, reason: c.issue.assignee?.id === me.id ? "assigned" : "mention" },
  };
}

/** A comment's body: the title as a bold link, then the text (Linear renders markdown). */
export function render(msg: OutboundMessage): string {
  const head = msg.title ? (msg.url ? `**[${msg.title}](${msg.url})**` : `**${msg.title}**`) : msg.url ? `<${msg.url}>` : "";
  return head ? `${head}\n\n${msg.text}` : msg.text;
}

/** A UUID v4 from a delivery's key: Linear accepts a client id on commentCreate, so the same
 *  delivery sent twice (a crash after the send) is one comment. */
export function commentId(key: string): string {
  const h = createHash("sha256").update(key).digest("hex").split("");
  h[12] = "4";
  h[16] = "89ab"[parseInt(h[16]!, 16) & 3]!;
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const newest = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

// ── The adapter ──────────────────────────────────────────────────────────────────────────────────

export type PollResult = { issues: number; comments: number; ingested: number; cursor?: string; error?: string; retryAfterMs?: number };
type Health = { ok: boolean; detail?: string; lastEventAt?: number; lastPollAt?: number };
export type LinearAdapter = Adapter & { poll(): Promise<PollResult> };

export function linearAdapter(connection: Connection): LinearAdapter {
  let ctx: AdapterContext | undefined;
  let me: LinearUser | undefined;
  let lastEventAt: number | undefined, lastPollAt: number | undefined;
  let inFlight: Promise<PollResult> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const token = () => ctx?.secret() ?? (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  const pollMs = () => Math.max(10, Number(connection.config.pollSeconds) || DEFAULT_POLL_SECONDS) * 1000;

  async function whoAmI(): Promise<GqlResult<LinearUser>> {
    const userId = typeof connection.config.userId === "string" && connection.config.userId ? connection.config.userId : undefined;
    const r = userId
      ? await linearRequest<{ user: LinearUser | null }>(token(), USER_QUERY, { id: userId })
      : await linearRequest<{ viewer: LinearUser }>(token(), VIEWER_QUERY);
    if (!r.ok) return r;
    const u = "user" in r.data ? r.data.user : r.data.viewer;
    return u ? { ok: true, data: u } : { ok: false, retryable: false, error: `Linear user ${userId} not found` };
  }

  async function pages<T extends { updatedAt: string }>(query: string, key: "issues" | "comments", filter: unknown): Promise<GqlResult<{ rows: T[]; more: boolean }>> {
    const rows: T[] = [];
    let after: string | undefined;
    for (let n = 0; n < MAX_PAGES; n++) {
      const r = await linearRequest<Record<string, { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } }>>(token(), query, { filter, ...(after ? { after } : {}) });
      if (!r.ok) return r;
      const page = r.data[key];
      rows.push(...(page?.nodes ?? []));
      if (!page?.pageInfo.hasNextPage || !page.pageInfo.endCursor) return { ok: true, data: { rows, more: false } };
      after = page.pageInfo.endCursor;
    }
    return { ok: true, data: { rows, more: true } };
  }

  async function pollNow(): Promise<PollResult> {
    if (!ctx || !me) return { issues: 0, comments: 0, ingested: 0, error: "not started" };
    const since = (await ctx.cursor.get()) ?? new Date().toISOString();
    const [issues, comments] = await Promise.all([
      pages<LinearIssue>(ISSUES_QUERY, "issues", issueFilter(since, me)),
      pages<LinearComment>(COMMENTS_QUERY, "comments", commentFilter(since, me)),
    ]);
    const failed = !issues.ok ? issues : !comments.ok ? comments : undefined;
    if (failed && !failed.ok) {
      await ctx.status({ ok: false, detail: `poll failed: ${failed.error}` });
      return { issues: 0, comments: 0, ingested: 0, error: failed.error, ...(failed.retryAfterMs ? { retryAfterMs: failed.retryAfterMs } : {}) };
    }
    const iRows = issues.ok ? issues.data.rows : [], cRows = comments.ok ? comments.data.rows : [];
    // Oldest first, so the cursor and the event order agree. When a page cap cut a list short, only
    // advance to the oldest of the two lists' newest rows: nothing between is skipped.
    type Item = { at: string; env?: InboundEnvelope };
    const items: Item[] = [
      ...iRows.map((i) => { const why = issueReason(i, me!); return { at: i.updatedAt, ...(why ? { env: issueEnvelope(connection.id, i, why, me!) } : {}) }; }),
      ...cRows.map((c) => ({ at: c.updatedAt, ...(commentWanted(c, me!) ? { env: commentEnvelope(connection.id, c, me!) } : {}) })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const cut: { updatedAt: string }[][] = [...(issues.ok && issues.data.more ? [iRows] : []), ...(comments.ok && comments.data.more ? [cRows] : [])];
    const caps = cut.map((r) => r.reduce((m, x) => newest(m, x.updatedAt), since));
    const limit = caps.length ? caps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : undefined;
    let next = since, ingested = 0;
    for (const it of items) {
      if (limit && Date.parse(it.at) > Date.parse(limit)) break;
      if (it.env && (await ctx.ingest(it.env)) === "new") { ingested++; lastEventAt = Date.now(); }
      next = newest(next, it.at);
    }
    if (next !== since) await ctx.cursor.set(next);
    lastPollAt = Date.now();
    await ctx.status({ ok: true, detail: `polled as ${me.name}`, lastPollAt, ...(lastEventAt ? { lastEventAt } : {}) });
    return { issues: iRows.length, comments: cRows.length, ingested, cursor: next };
  }

  /** One poll at a time: a call while one runs waits for it, then polls again. */
  function poll(): Promise<PollResult> {
    const run = (inFlight ?? Promise.resolve()).catch(() => undefined).then(() => pollNow()).catch(async (e) => {
      const error = e instanceof Error ? e.message : String(e);
      await ctx?.status({ ok: false, detail: `poll failed: ${error}` }).catch(() => {});
      return { issues: 0, comments: 0, ingested: 0, error };
    });
    inFlight = run;
    return run;
  }

  function loop(signal: AbortSignal): void {
    if (signal.aborted) return;
    void poll().then((r) => {
      if (signal.aborted) return;
      timer = setTimeout(() => loop(signal), Math.max(pollMs(), r.retryAfterMs ?? 0));
    });
  }

  return {
    kind: "linear",
    caps: LINEAR_CAPS,
    poll,
    async start(c) {
      ctx = c;
      if (!token()) throw new Error(`${connection.secretRef ?? "the API key variable"} is not set`);
      const who = await whoAmI();
      if (!who.ok) throw new Error(`Linear: ${who.error}`);
      me = who.data;
      // The first start reads from now (minus `lookbackMinutes`), not the workspace's whole history.
      if (!(await c.cursor.get())) await c.cursor.set(new Date(Date.now() - (Number(connection.config.lookbackMinutes) || 0) * 60_000).toISOString());
      c.log(`polling as ${me.name} every ${pollMs() / 1000}s`);
      loop(c.signal);
    },
    async stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight?.catch(() => undefined);
      ctx = undefined;
    },
    async send(target: Target, msg: OutboundMessage, key: string): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the API key variable"} is not set` };
      const issueId = target.threadId;
      // Linear has no channel to post in: a comment needs an issue. A workstream with no linked
      // issue has nothing to post to, which is not a failure to retry.
      if (!issueId) return { ok: true };
      const body = render(msg);
      if (msg.edit && target.messageId) {
        const r = await linearRequest<{ commentUpdate: { success: boolean; comment?: { id: string } } }>(token(), COMMENT_UPDATE, { id: target.messageId, input: { body } });
        if (!r.ok) return r;
        return r.data.commentUpdate?.success ? { ok: true, externalMsgId: target.messageId, threadId: issueId } : { ok: false, retryable: true, error: "commentUpdate was not a success" };
      }
      const id = commentId(`${connection.id}:${key}`);
      // A reply (`orca post --reply`, the inbox's Reply) goes under the comment it answers.
      const parentId = msg.replyToExternalMsgId;
      const r = await linearRequest<{ commentCreate: { success: boolean; comment?: { id: string } } }>(token(), COMMENT_CREATE, { input: { id, issueId, body, ...(parentId ? { parentId } : {}) } });
      // A second send of one delivery reuses its id; Linear refuses the copy, so the first one stands.
      if (!r.ok) return /already exists|duplicate|unique constraint/i.test(r.error) ? { ok: true, externalMsgId: id, threadId: issueId } : r;
      return r.data.commentCreate?.success ? { ok: true, externalMsgId: r.data.commentCreate.comment?.id ?? id, threadId: issueId } : { ok: false, retryable: true, error: "commentCreate was not a success" };
    },
    async health(): Promise<Health> {
      const polled = { ...(lastEventAt ? { lastEventAt } : {}), ...(lastPollAt ? { lastPollAt } : {}) };
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "API key"} is not set`, ...polled };
      const r = await whoAmI();
      return r.ok ? { ok: true, detail: `signed in as ${r.data.name}`, ...polled } : { ok: false, detail: r.error, ...polled };
    },
    async resolveUser(externalId: string) {
      const r = await linearRequest<{ user: LinearUser | null }>(token(), USER_QUERY, { id: externalId });
      return r.ok && r.data.user ? { id: r.data.user.id, name: r.data.user.displayName ?? r.data.user.name } : undefined;
    },
  };
}
