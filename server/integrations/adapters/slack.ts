// The Slack adapter (docs/research/integrations.md §5; setup: docs/integrations/slack.md). Two-way,
// as YOU: the row's token is a user token (`xoxp`, SLACK_TOKEN), so every post is in your name, and
// Orca reads what you can read. Dependency-free: the Web API is plain `fetch`; the optional Socket
// Mode is a hand client over Bun's WebSocket, like adapters/discord.ts.
//
// OUTBOUND: `chat.postMessage` (a thread reply with `thread_ts`, thread id `channel:thread_ts`),
// `chat.update` for an edit, the retryable/fatal split and a 1-per-second pace per channel. A target
// that is a user id (`U…`) or a list of them (`U1,U2`) is a DM or group DM: `conversations.open`
// gives its channel first. `postMessage` / `postAsUser` keep /api/slack's post exactly as it was.
// `msg.attachments` (`orca post --attach`) go as files on the same message: Slack's own two-step
// external upload (`uploadFiles`: `files.getUploadURLExternal` per file, the bytes POSTed to the
// returned `upload_url`, then one `files.completeUploadExternal` that shares every file into the
// channel with the text as `initial_comment`) — so the files and the text land as one message, the
// way `orca gmail attachment` and `orca slack file` (server/slackTool.ts) read a file the other way.
// files.completeUploadExternal names no message `ts`, so a brand-new conversation gets no thread
// pointer back from an attached post (an existing thread is kept as given). Needs the scope
// `files:write`; a `missing_scope` answer is worded with the scope name (`missingScopeHint`).
//
// INBOUND, with SLACK_TOKEN alone: a poll every `pollSeconds` (see "Polling" below). With an app-level
// token (`xapp`, the variable `config.appTokenRef` names, default SLACK_APP_TOKEN) Socket Mode is used
// instead: `apps.connections.open`, every envelope acked at once. `config.inbound` ("poll", "socket",
// "off") picks one by hand. A message becomes one envelope when another person wrote it and it is one of:
// - a mention of you (`<@you>`) in a channel or private channel;
// - a DM to you (source channel `D…`, parent `im`) or a group DM (parent `mpim`);
// - a reply in a thread Orca already talks in (a mention came there, or Orca posted there).
// Your own messages never count, so a post Orca makes as you never comes back in. The thread is
// `channel:thread_ts` (a channel mention starts one on itself); a top-level DM is the DM channel
// itself, so the answer goes in the DM, not in a thread. Tokens are never logged, never in `raw`.
import type { Adapter, AdapterContext, Connection, IngestVerdict } from "../adapter";
import { secretValue } from "../secretRefs";
import { ORCA_SECRETS } from "../../env";
import * as db from "../../db";
import { MAX_ATTACHMENT_BYTES } from "../../attachments";
import { attachmentIdOf, attachmentRefusal, inboundEnvelope, secretRefRefusal, type Capabilities, type InboundEnvelope, type OutboundMessage, type SendResult, type Target } from "../../../shared/integrations";

const API = "https://slack.com/api/";

export type SlackResult = { ok: boolean; error?: string; retryAfterMs?: number; [k: string]: unknown };

const answer = async (res: Response): Promise<SlackResult> => {
  const data = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as SlackResult;
  const retry = Number(res.headers?.get?.("retry-after"));
  return res.status === 429 && retry > 0 ? { ...data, ok: false, error: data.error ?? "ratelimited", retryAfterMs: retry * 1000 } : data;
};

/** One Web API call with a JSON body (the write methods). Slack answers HTTP 200 with
 *  `{ok:false,error}` for a logical failure; a network error comes back in the same shape. Never
 *  throws. `retryAfterMs` is Slack's Retry-After on a 429. */
export async function slackApi(token: string, method: string, body: Record<string, unknown>): Promise<SlackResult> {
  try {
    return await answer(await fetch(API + method, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One Web API call with a form body: the read methods (conversations.history, search.messages,
 *  users.info …) take their arguments as a form or a query, never as JSON. Never throws. */
export async function slackRead(token: string, method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<SlackResult> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") form.set(k, String(v));
  try {
    return await answer(await fetch(API + method, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` },
      body: form.toString(),
    }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const userToken = () => process.env.SLACK_TOKEN ?? "";

/** Today's post, byte for byte: `{channel, text}` to chat.postMessage as the user. Pure I/O. */
export async function postMessage(channel: string, text: string): Promise<{ ok: boolean; error?: string; channel?: string }> {
  if (!userToken()) return { ok: false, error: "SLACK_TOKEN is not set" };
  const { retryAfterMs: _r, ...data } = await slackApi(userToken(), "chat.postMessage", { channel, text });
  return data as { ok: boolean; error?: string; channel?: string };
}

/** Errors a retry cannot fix (auth, a wrong channel, a bad message). */
const FATAL = new Set([
  "not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "no_permission", "missing_scope",
  "channel_not_found", "user_not_found", "users_not_found", "is_archived", "not_in_channel", "msg_too_long", "no_text", "cant_update_message", "message_not_found", "edit_window_closed",
  "SLACK_TOKEN is not set", "no token",
]);
/** `apps.connections.open` errors no reconnect can fix: a bad app token, or Socket Mode off. */
const FATAL_OPEN = new Set(["not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "no_permission", "missing_scope", "not_allowed_token_type"]);

/** A thread id is `channel:thread_ts` (§3.6); the ts part is what Slack wants. A bare ts is a ts; a
 *  bare channel id (a top-level DM conversation) is no thread. */
export const threadTs = (threadId?: string): string | undefined =>
  threadId?.includes(":") ? threadId.slice(threadId.indexOf(":") + 1) || undefined : threadId && /^\d+\.\d+$/.test(threadId) ? threadId : undefined;

/** A conservative cap on files in one `files.completeUploadExternal` call: Slack documents no hard
 *  number, so this keeps one message from naming an unbounded batch, like Discord's own cap. */
export const SLACK_MAX_FILES = 10;
export const SLACK_CAPS: Capabilities = {
  inbound: "poll", outbound: true, threads: true, edits: true, reactions: false, attachments: true,
  maxAttachments: SLACK_MAX_FILES, maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxTextLength: 39_000, rate: { perTarget: 1, windowMs: 1_000 },
};

/** One file ready for Slack's upload: its name, type and bytes (the attachment table's shape). */
export type SlackUploadFile = { name: string; type: string; bytes: Uint8Array };

/** The files of `refs`, read from the attachment table, or the SendResult that ends the send: a
 *  file the table lost or over Slack's limits is final; a database error throws, and the core
 *  retries the delivery (same contract as Discord's `loadFiles`). */
export async function loadSlackFiles(refs: string[]): Promise<SlackUploadFile[] | SendResult> {
  const files: SlackUploadFile[] = [];
  for (const ref of refs) {
    const id = attachmentIdOf(ref);
    const row = id ? await db.attachment(id) : undefined;
    if (!row) return { ok: false, retryable: false, error: `attachment ${ref} is gone (pruned after 30 days, or never stored)` };
    files.push({ name: row.filename.replace(/[^\w.-]+/g, "-") || "file", type: row.mimeType || "application/octet-stream", bytes: row.bytes });
  }
  const refusal = attachmentRefusal("slack", SLACK_CAPS, files.map((f) => ({ name: f.name, bytes: f.bytes.byteLength })));
  return refusal ? { ok: false, retryable: false, error: refusal } : files;
}

/** Slack's `missing_scope` worded with the scope it names (falling back to `files:write`, the one
 *  this upload needs) and the setup doc — the same wording `slackTool.ts`'s `fail` gives every other
 *  call. Everything else passes through untouched. Pure given the result. */
export function missingScopeHint(r: { error?: string; needed?: unknown }): string {
  if (r.error !== "missing_scope") return "";
  const needed = typeof r.needed === "string" ? r.needed : "files:write";
  return ` (the user token needs the scope ${needed}; see docs/integrations/slack.md)`;
}

/** Slack's two-step external upload (docs/integrations/slack.md §2): a presigned URL per file
 *  (`files.getUploadURLExternal`), the raw bytes POSTed to it, then ONE `files.completeUploadExternal`
 *  that shares every file into `channel` (and `threadTs`) with `initialComment` as the message text —
 *  so the files and the text land as one message. Never throws: a Slack error or a failed upload
 *  comes back as `{ok:false, error}`, like every other call here. The finalize call names no message
 *  `ts` (Slack's own contract), so the caller cannot learn a brand-new conversation's thread key. */
export async function uploadFiles(token: string, files: SlackUploadFile[], target: { channel?: string; threadTs?: string; initialComment?: string }): Promise<SlackResult> {
  const tickets: { id: string; title: string }[] = [];
  for (const f of files) {
    const got = await slackRead(token, "files.getUploadURLExternal", { filename: f.name, length: f.bytes.byteLength });
    if (!got.ok || typeof got.upload_url !== "string" || typeof got.file_id !== "string") {
      return got.ok ? { ok: false, error: "files.getUploadURLExternal gave no upload_url" } : got;
    }
    const form = new FormData();
    form.append("file", new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    let res: Response;
    try { res = await fetch(got.upload_url, { method: "POST", body: form }); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (!res.ok) return { ok: false, error: `the upload of ${f.name} failed: http ${res.status}` };
    tickets.push({ id: got.file_id, title: f.name });
  }
  return slackApi(token, "files.completeUploadExternal", {
    files: tickets,
    ...(target.channel ? { channel_id: target.channel } : {}),
    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
    ...(target.initialComment ? { initial_comment: target.initialComment } : {}),
  });
}

/** The default name of the app-level token's variable (Socket Mode). */
export const APP_TOKEN_REF = "SLACK_APP_TOKEN";
/** The parent place of every DM and every group DM: a link on `im` / `mpim` takes them all. */
export const DM_PLACE = "im";
export const GROUP_DM_PLACE = "mpim";

/** The text a delivery posts: the title linked to its URL (Slack mrkdwn), then the text. */
export function render(msg: OutboundMessage): string {
  const head = msg.title ? (msg.url ? `<${msg.url}|${msg.title}>` : `*${msg.title}*`) : msg.url ? `<${msg.url}>` : "";
  return head ? `${head}\n${msg.text}` : msg.text;
}

/** True for a user id (`U…`, `W…`) or a comma list of them: a DM or group DM to open. Pure. */
export const isUserTarget = (s: string): boolean => /^[UW][A-Z0-9]+(,[UW][A-Z0-9]+)*$/.test(s.replace(/\s+/g, ""));

/** The channel id of a DM (one user id) or a group DM (several): `conversations.open` (scopes
 *  im:write / mpim:write). Anything else is already a channel and passes as is. */
export async function openConversation(token: string, target: string): Promise<{ ok: true; channel: string } | { ok: false; error: string; retryAfterMs?: number }> {
  if (!isUserTarget(target)) return { ok: true, channel: target };
  const r = await slackRead(token, "conversations.open", { users: target.replace(/\s+/g, "") });
  const id = (r.channel as { id?: unknown } | undefined)?.id;
  return r.ok && typeof id === "string" ? { ok: true, channel: id } : { ok: false, error: r.error ?? "conversations.open gave no channel", ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
}

// ── Inbound ──────────────────────────────────────────────────────────────────────────────────────

/** The parts of a Slack `message` event Orca reads. */
export type SlackEvent = {
  type?: string; subtype?: string; user?: string; bot_id?: string; text?: string; ts?: string;
  channel?: string; channel_type?: string; thread_ts?: string; event_ts?: string;
};

/** Message subtypes that are a person writing. Every other one (edits, deletes, joins, bots) is not. */
const PERSON_SUBTYPES = new Set(["", "file_share", "thread_broadcast"]);

/** `config.botSenders`, comma-separated Slack user ids: a bot message from one of these still
 *  reaches Orca, as if a person sent it (the actor is that user id). Every other bot message is
 *  still dropped. Opt-in, because a bot normally has nobody to notify or answer for it. Pure. */
export function botSendersOf(config: Record<string, unknown>): Set<string> {
  const raw = config.botSenders;
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Slack's three escaped characters, back to plain text. */
const unescape = (t: string): string => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The place a message is in: a DM, a group DM or a channel. Slack's `channel_type`, else the id. */
export const placeOf = (ev: Pick<SlackEvent, "channel" | "channel_type">): "im" | "mpim" | "channel" =>
  ev.channel_type === "im" || (!ev.channel_type && ev.channel?.startsWith("D")) ? "im"
    : ev.channel_type === "mpim" ? "mpim" : "channel";

/** The thread key of a message: `channel:thread_ts` in a thread; a top-level channel message starts
 *  one on itself (`channel:ts`); a top-level DM or group DM is the conversation itself. Pure. */
export const threadKeyOf = (ev: Pick<SlackEvent, "channel" | "channel_type" | "ts" | "thread_ts">): string =>
  ev.thread_ts ? `${ev.channel}:${ev.thread_ts}` : placeOf(ev) === "channel" ? `${ev.channel}:${ev.ts}` : ev.channel!;

/** A link that opens one message in Slack: the workspace URL (auth.test's `url`), the channel and
 *  the ts; a reply in a thread names its thread too. Undefined without the workspace URL. Pure. */
export function slackPermalink(base: string | undefined, ev: Pick<SlackEvent, "channel" | "ts" | "thread_ts">): string | undefined {
  if (!base || !ev.channel || !ev.ts) return undefined;
  const root = base.replace(/\/+$/, "");
  const thread = ev.thread_ts && ev.thread_ts !== ev.ts ? `?thread_ts=${ev.thread_ts}&cid=${ev.channel}` : "";
  return `${root}/archives/${ev.channel}/p${ev.ts.replace(".", "")}${thread}`;
}

/** The place a person reads: DM, Group DM, else `#name` when the channel's name is known. Pure. */
export const placeLabel = (place: "im" | "mpim" | "channel", channelName?: string): string | undefined =>
  place === "im" ? "DM" : place === "mpim" ? "Group DM" : channelName ? `#${channelName}` : undefined;

/** One Socket Mode `message` event as the core's envelope, or undefined when it is not for Orca. Pure.
 *  `me` is the token's own user (`url`: its workspace, for the message's link); `known` says whether
 *  Orca already talks in a thread key; `channelName` names a channel for the place; `botSenders`
 *  (`botSendersOf`) lets a listed bot user through despite `bot_id` — its subtype must still be a
 *  person subtype (a listed id with `subtype: "bot_message"` is still dropped). */
export function slackInbound(ev: SlackEvent, me: { team: string; userId: string; name?: string; integrationId: string; url?: string }, o: { known?: (threadKey: string) => boolean; senderName?: string; channelName?: string; botSenders?: Set<string> } = {}): InboundEnvelope | undefined {
  if (ev.type !== "message") return undefined;
  const allowedBot = Boolean(ev.bot_id && ev.user && o.botSenders?.has(ev.user));
  if (!PERSON_SUBTYPES.has(ev.subtype ?? "") || (ev.bot_id && !allowedBot) || !ev.user || ev.user === me.userId) return undefined;
  if (!ev.channel || !ev.ts) return undefined;
  const place = placeOf(ev);
  const tag = `<@${me.userId}>`;
  const raw = ev.text ?? "";
  const key = threadKeyOf(ev);
  const mentioned = place !== "channel" || raw.includes(tag) || raw.includes(`<@${me.userId}|`) || Boolean(ev.thread_ts && o.known?.(key));
  if (!mentioned) return undefined; // a channel's other chatter never leaves the adapter
  const text = unescape(raw.replace(new RegExp(`<@${me.userId}(\\|[^>]*)?>`, "g"), me.name ? `@${me.name}` : "").replace(/[ \t]{2,}/g, " ").trim());
  if (!text) return undefined;
  const e = inboundEnvelope({
    adapter: "slack", integrationId: me.integrationId,
    channel: ev.channel, eventId: `${me.team}:${ev.channel}:${ev.ts}`,
    from: { adapter: "slack", id: ev.user, ...(o.senderName ? { name: o.senderName } : {}) },
    text, mentioned: true,
    thread: { adapter: "slack", externalId: key, messageId: ev.ts },
    ...(Number(ev.ts) ? { at: Math.round(Number(ev.ts) * 1000) } : {}),
    raw: { channel: ev.channel, ts: ev.ts, channel_type: ev.channel_type }, // ids only: no content twice, never a token
  });
  const url = slackPermalink(me.url, ev), shown = placeLabel(place, o.channelName);
  const out: InboundEnvelope = { ...e, ...(url ? { link: { url } } : {}), ...(shown ? { display: { place: shown } } : {}) };
  // A DM's or group DM's channel id is new for each person: a link on `im` / `mpim` takes them all.
  return place === "channel" ? out : { ...out, source: { ...out.source, parents: [place === "im" ? DM_PLACE : GROUP_DM_PLACE] } };
}

/** The WebSocket constructor Socket Mode uses, and the first reconnect wait. A test swaps in a fake. */
export type WebSocketLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
};
export const socketMode = { WebSocket: globalThis.WebSocket as unknown as new (url: string) => WebSocketLike, baseBackoffMs: 1_000 };

/** The wait before reconnect number `attempt`: 1s, 2s, 4s … 60s; Slack's Retry-After wins when longer. */
export const backoffMs = (attempt: number, retryAfterMs = 0): number => Math.max(Math.min(60_000, socketMode.baseBackoffMs * 2 ** attempt), retryAfterMs);

/** The size of the user-name map. */
const MAP_CAP = 5_000;
const remember = <V>(map: Map<string, V>, k: string, v: V) => {
  map.delete(k);
  map.set(k, v);
  if (map.size > MAP_CAP) map.delete(map.keys().next().value!);
};

// ── Polling (the default inbound: SLACK_TOKEN alone) ─────────────────────────────────────────────
// Every `pollSeconds` (default 60):
// (a) DMs and group DMs: conversations.list (types im,mpim, cached 5 min), then conversations.history
//     from each one's last-seen ts. Slack gives a user token no "last message" time for a
//     conversation, so a DM with a message in the last 24 h is read on every poll, and the others
//     in turns, at most `historyBudget` calls a poll. Each keeps its own ts: a message in a quiet DM
//     comes late, never lost.
// (b) Mentions in channels: search.messages for `<@you>`, newest first, back to the last-seen ts
//     less 5 min (search indexes late; the core's key dedupes the overlap).
// (c) Replies in threads Orca talks in: conversations.replies from each thread's last-seen ts.
// The cursor (integration_cursor, one JSON value) keeps every ts and the threads, so a restart
// neither replays nor misses. A 429 ends the poll; the next one waits for Slack's Retry-After.

/** What the poller and Socket Mode keep between polls and restarts. Every ts is Slack's string. */
export type SlackCursor = {
  v: 1;
  /** When polling began: the floor for a DM not seen yet. */
  start: string;
  /** The newest mention read by search. */
  mention: string;
  /** DM or group DM channel id → the newest ts read there. */
  dms: Record<string, string>;
  /** Thread key (`channel:thread_ts`) Orca talks in → the newest ts read there. */
  threads: Record<string, string>;
};

/** A ts for a time in ms. */
export const tsOf = (ms: number): string => `${Math.floor(ms / 1000)}.000000`;
const tsMs = (ts: string | undefined): number => Number(ts ?? 0) * 1000;
/** The later of two ts. */
export const laterTs = (a: string, b: string | undefined): string => (b && Number(b) > Number(a) ? b : a);

/** The stored cursor, or a new one that starts now (a first start reads no history). Pure. */
export function parseCursor(raw: string | undefined, now: number): SlackCursor {
  try {
    const c = raw ? (JSON.parse(raw) as Partial<SlackCursor>) : undefined;
    if (c?.v === 1 && typeof c.start === "string") {
      return { v: 1, start: c.start, mention: typeof c.mention === "string" ? c.mention : c.start, dms: { ...(c.dms ?? {}) }, threads: { ...(c.threads ?? {}) } };
    }
  } catch { /* a bad value starts again from now */ }
  const t = tsOf(now);
  return { v: 1, start: t, mention: t, dms: {}, threads: {} };
}

/** A thread with no activity for this long is no longer polled. */
export const THREAD_TTL_MS = 7 * 24 * 60 * 60_000;
/** At most this many threads are kept (the newest). */
export const MAX_THREADS = 200;
/** A DM with a message this recent is read on every poll. */
export const HOT_MS = 24 * 60 * 60_000;
/** Search reads back this far before the last mention: search indexes late. */
export const MENTION_OVERLAP_S = 300;

/** The threads still worth a poll: active in the last week, the newest MAX_THREADS. Pure. */
export function pruneThreads(threads: Record<string, string>, now: number): Record<string, string> {
  return Object.fromEntries(Object.entries(threads)
    .filter(([, ts]) => now - tsMs(ts) < THREAD_TTL_MS)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_THREADS));
}

/** The DMs to read this poll: every hot one (newest first), then the others in turns from `next`,
 *  `budget` in all. Returns where the turns go on next time. Pure. */
export function pickConversations(ids: string[], dms: Record<string, string>, now: number, budget: number, next: number): { pick: string[]; next: number } {
  const hot = ids.filter((id) => dms[id] && now - tsMs(dms[id]) < HOT_MS).sort((a, b) => Number(dms[b]) - Number(dms[a]));
  const pick = hot.slice(0, budget);
  const cold = ids.filter((id) => !hot.includes(id));
  const room = Math.min(budget - pick.length, cold.length);
  const from = cold.length ? next % cold.length : 0;
  for (let i = 0; i < room; i++) pick.push(cold[(from + i) % cold.length]!);
  return { pick, next: cold.length ? (from + room) % cold.length : 0 };
}

/** One search.messages match. */
export type SearchMatch = { ts?: string; text?: string; user?: string; permalink?: string; channel?: { id?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean } };

/** A search match as a message event: the thread from the permalink's `thread_ts`. A match in a DM
 *  or group DM is left to the DM poll. Pure. */
export function searchEvent(m: SearchMatch): SlackEvent | undefined {
  if (!m.channel?.id || !m.ts || m.channel.is_im || m.channel.is_mpim) return undefined;
  let thread: string | undefined;
  try { thread = m.permalink ? new URL(m.permalink).searchParams.get("thread_ts") ?? undefined : undefined; } catch { /* no thread */ }
  return { type: "message", user: m.user, text: m.text, ts: m.ts, channel: m.channel.id, channel_type: m.channel.is_private ? "group" : "channel", ...(thread && thread !== m.ts ? { thread_ts: thread } : {}) };
}

export type SlackPollResult = { ingested: number; calls: number; error?: string; retryAfterMs?: number };
export type SlackAdapter = Adapter & { poll(): Promise<SlackPollResult> };

const DEFAULT_POLL_SECONDS = 60;
const DEFAULT_HISTORY_BUDGET = 20;
const MAX_HISTORY_PAGES = 5;
const MAX_SEARCH_PAGES = 3;
const CONVERSATIONS_TTL_MS = 5 * 60_000;
type SlackMessage = SlackEvent & { reply_count?: number };

export function slackAdapter(connection: Connection, opts: { openDms?: boolean } = {}): SlackAdapter {
  const token = () => secretValue(connection.secretRef) ?? "";
  const appRef = typeof connection.config.appTokenRef === "string" && connection.config.appTokenRef ? connection.config.appTokenRef : APP_TOKEN_REF;
  const appToken = () => secretValue(appRef) ?? "";
  // `config.inbound`: "poll", "socket" or "off". Unset: Socket Mode when the app-level token is set, else polling.
  const mode = (): "poll" | "socket" | "off" => {
    const want = String(connection.config.inbound ?? "");
    if (want === "off") return "off";
    if (want === "poll") return "poll";
    return appToken() ? "socket" : "poll";
  };
  const pollMs = () => Math.max(15, Number(connection.config.pollSeconds) || DEFAULT_POLL_SECONDS) * 1000;
  const budget = () => Math.max(1, Number(connection.config.historyBudget) || DEFAULT_HISTORY_BUDGET);
  let ctx: AdapterContext | undefined;
  let ws: WebSocketLike | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  let running: "poll" | "socket" | "off" = "off";
  let me = { team: "", userId: "", name: "", url: "" };
  let state: { ok: boolean; detail?: string; lastEventAt?: number; lastPollAt?: number } = { ok: false, detail: "not started" };
  let cur: SlackCursor = parseCursor(undefined, Date.now()); // the threads live here in both modes
  let conversations: { at: number; list: { id: string; place: "im" | "mpim" }[] } | undefined;
  let turn = 0; // where the quiet DMs' turns go on
  let inFlight: Promise<SlackPollResult> | undefined;
  const names = new Map<string, string>(); // user id → display name
  const channels = new Map<string, string>(); // channel id → name

  const setState = (s: typeof state) => { state = { ...state, ...s }; void ctx?.status(state).catch(() => {}); };
  const saveCursor = () => ctx?.cursor.set(JSON.stringify(cur)) ?? Promise.resolve();
  const talkIn = (key: string, ts: string) => { cur.threads[key] = laterTs(cur.threads[key] ?? "0", ts); };

  async function nameOf(user: string): Promise<string | undefined> {
    const known = names.get(user);
    if (known !== undefined) return known || undefined;
    const r = await slackRead(token(), "users.info", { user });
    const u = r.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
    const name = r.ok ? u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || "" : "";
    if (r.ok) remember(names, user, name); // a failed read is not kept: the next message reads again
    return name || undefined;
  }

  async function channelName(id: string): Promise<string | undefined> {
    const known = channels.get(id);
    if (known !== undefined) return known || undefined;
    const r = await slackRead(token(), "conversations.info", { channel: id });
    const name = r.ok ? String((r.channel as { name?: string } | undefined)?.name ?? "") : "";
    if (r.ok) remember(channels, id, name);
    return name || undefined;
  }

  /** One message event, from the socket or a poll: the envelope, the sender's name, the core. */
  async function handle(ev: SlackEvent, team = ""): Promise<IngestVerdict | undefined> {
    if (!ctx || ev.type !== "message" || !ev.user || ev.user === me.userId) return undefined;
    const opts = { known: (k: string) => k in cur.threads, botSenders: botSendersOf(connection.config) };
    const who = { team: team || me.team, userId: me.userId, name: me.name, integrationId: connection.id, url: me.url };
    let made = slackInbound(ev, who, opts);
    if (!made) return undefined;
    // A channel's name, for the place a person reads (a DM and a group DM need no call).
    if (placeOf(ev) === "channel") {
      const name = await channelName(ev.channel!).catch(() => undefined);
      if (name) made = slackInbound(ev, who, { ...opts, channelName: name }) ?? made;
    }
    const senderName = await nameOf(ev.user).catch(() => undefined);
    const e = senderName ? { ...made, actor: { external: { ...made.actor!.external, name: senderName } } } : made;
    const verdict = await ctx.ingest(e);
    if (verdict === "new" || verdict === "noted") state.lastEventAt = Date.now();
    // A reply in its thread now needs no mention. A top-level DM is its own conversation: no thread.
    // Not for a noted message: no agent answers there, so Orca does not talk in that thread.
    if (verdict === "new" && e.thread?.externalId.includes(":")) talkIn(e.thread.externalId, ev.ts!);
    return verdict;
  }

  // ── The poller ──

  async function dmList(call: (m: string, p: Record<string, string | number | boolean | undefined>) => Promise<SlackResult>): Promise<{ id: string; place: "im" | "mpim" }[] | undefined> {
    if (conversations && Date.now() - conversations.at < CONVERSATIONS_TTL_MS) return conversations.list;
    const list: { id: string; place: "im" | "mpim" }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await call("conversations.list", { types: "im,mpim", exclude_archived: true, limit: 200, cursor });
      if (!r.ok) return undefined;
      for (const c of (r.channels as { id?: string; is_mpim?: boolean; is_user_deleted?: boolean }[] | undefined) ?? []) {
        if (c.id && !c.is_user_deleted) list.push({ id: c.id, place: c.is_mpim ? "mpim" : "im" });
      }
      cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      if (!cursor) break;
    }
    conversations = { at: Date.now(), list };
    return list;
  }

  async function pollNow(): Promise<SlackPollResult> {
    if (!ctx) return { ingested: 0, calls: 0, error: "not started" };
    const now = Date.now();
    // `cur` is read once at start: this bridge alone owns it, and `send` adds threads to it between polls.
    cur.threads = pruneThreads(cur.threads, now);
    let calls = 0, ingested = 0, retryAfterMs = 0;
    const errors: string[] = [];
    const call = async (method: string, params: Record<string, string | number | boolean | undefined>): Promise<SlackResult> => {
      calls++;
      const r = await slackRead(token(), method, params);
      if (r.retryAfterMs) retryAfterMs = Math.max(retryAfterMs, r.retryAfterMs);
      if (!r.ok) errors.push(`${method}: ${r.error ?? "unknown error"}`);
      return r;
    };
    const limited = () => retryAfterMs > 0;
    const take = async (ev: SlackEvent) => { const v = await handle(ev); if (v === "new" || v === "noted") ingested++; };

    // (a) DMs and group DMs.
    const list = await dmList(call);
    if (list && !limited()) {
      const { pick, next } = pickConversations(list.map((c) => c.id), cur.dms, now, budget(), turn);
      turn = next;
      for (const id of pick) {
        if (limited()) break;
        const place = list.find((c) => c.id === id)!.place;
        const oldest = cur.dms[id] ?? cur.start;
        const msgs: SlackMessage[] = [];
        let cursor: string | undefined;
        let ok = true;
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
          const r = await call("conversations.history", { channel: id, oldest, limit: 200, cursor });
          if (!r.ok) { ok = false; break; }
          msgs.push(...((r.messages as SlackMessage[] | undefined) ?? []));
          cursor = r.has_more ? (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined : undefined;
          if (!cursor) break;
        }
        if (!ok) continue;
        for (const m of msgs.filter((x) => Number(x.ts) > Number(oldest)).sort((a, b) => Number(a.ts) - Number(b.ts))) {
          await take({ ...m, type: "message", channel: id, channel_type: place });
          cur.dms[id] = laterTs(cur.dms[id] ?? oldest, m.ts);
        }
      }
    }

    // (b) Mentions in channels, by search.
    // Newest first, page by page, until a page reaches back past the floor. Never before `start`.
    const floor = Math.max(Number(cur.start), Number(cur.mention) - MENTION_OVERLAP_S);
    const found: SearchMatch[] = [];
    // `complete`: the pages reached the floor. Only then does the cursor move: a search cut short
    // (a 429, an error, the page cap) reads the same span again next time, and the core's key dedupes.
    let complete = false;
    for (let page = 1; page <= MAX_SEARCH_PAGES && !limited(); page++) {
      const r = await call("search.messages", { query: `<@${me.userId}>`, sort: "timestamp", sort_dir: "desc", count: 50, page });
      if (!r.ok) break;
      const msgs = r.messages as { matches?: SearchMatch[]; paging?: { pages?: number } } | undefined;
      const matches = msgs?.matches ?? [];
      found.push(...matches.filter((m) => Number(m.ts) > floor));
      if (!matches.length || Number(matches.at(-1)!.ts) <= floor || page >= (msgs?.paging?.pages ?? 1)) { complete = true; break; }
    }
    for (const m of found.sort((a, b) => Number(a.ts) - Number(b.ts))) {
      const ev = searchEvent(m);
      if (ev) await take(ev);
      if (complete) cur.mention = laterTs(cur.mention, m.ts);
    }

    // (c) Replies in threads Orca talks in, the most recent first.
    const keys = Object.keys(cur.threads).filter((k) => /^[^:]+:\d+\.\d+$/.test(k)).sort((a, b) => Number(cur.threads[b]) - Number(cur.threads[a]));
    for (const key of keys.slice(0, budget())) {
      if (limited()) break;
      const [channel, thread] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const oldest = cur.threads[key]!;
      const r = await call("conversations.replies", { channel, ts: thread, oldest, limit: 200 });
      if (!r.ok) continue;
      const place = channel.startsWith("D") ? "im" : "channel";
      for (const m of ((r.messages as SlackMessage[] | undefined) ?? []).filter((x) => Number(x.ts) > Number(oldest) && x.ts !== thread).sort((a, b) => Number(a.ts) - Number(b.ts))) {
        await take({ ...m, type: "message", channel, channel_type: place, thread_ts: thread });
        talkIn(key, m.ts!);
      }
    }

    await saveCursor();
    const lastPollAt = Date.now();
    const error = errors.length ? errors.slice(0, 3).join("; ") : undefined;
    setState({ ok: !error, detail: error ? `poll: ${error}` : `polling every ${pollMs() / 1000}s as ${me.name || me.userId}`, lastPollAt });
    return { ingested, calls, ...(error ? { error } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) };
  }

  /** One poll at a time: a call while one runs waits for it, then polls again. Never throws. */
  function poll(): Promise<SlackPollResult> {
    const run = (inFlight ?? Promise.resolve()).catch(() => undefined).then(() => pollNow()).catch((e) => {
      const error = e instanceof Error ? e.message : String(e);
      setState({ ok: false, detail: `poll failed: ${error}` });
      return { ingested: 0, calls: 0, error };
    });
    inFlight = run;
    return run;
  }

  function loop(): void {
    if (stopped) return;
    void poll().then((r) => {
      if (stopped) return;
      retry = setTimeout(loop, Math.max(pollMs(), r.retryAfterMs ?? 0));
    });
  }

  // ── Socket Mode (optional: only with SLACK_APP_TOKEN) ──

  async function connect(): Promise<void> {
    if (stopped) return;
    const open = await slackRead(appToken(), "apps.connections.open");
    if (stopped) return;
    if (!open.ok || typeof open.url !== "string") {
      if (FATAL_OPEN.has(open.error ?? "")) {
        setState({ ok: false, detail: `Slack refused the app-level token (${open.error}); check ${appRef} and that Socket Mode is on` });
        return;
      }
      setState({ ok: false, detail: `apps.connections.open: ${open.error ?? "no url"}; retrying` });
      retry = setTimeout(() => void connect(), backoffMs(attempt++, open.retryAfterMs));
      return;
    }
    const sock = new socketMode.WebSocket(open.url);
    ws = sock;
    sock.onmessage = (m) => {
      let p: { type?: string; envelope_id?: string; reason?: string; payload?: { team_id?: string; event?: SlackEvent } };
      try { p = JSON.parse(String(m.data)); } catch { return; }
      // Ack first, every envelope: Slack sends an envelope again when it gets no ack in 3 s.
      if (p.envelope_id) { try { sock.send(JSON.stringify({ envelope_id: p.envelope_id })); } catch { /* the close handler reconnects */ } }
      if (p.type === "hello") { attempt = 0; setState({ ok: true, detail: `Socket Mode connected as ${me.name || me.userId}` }); return; }
      // Slack asks for a new connection (a refresh, about every few hours): open one at once.
      if (p.type === "disconnect") { try { sock.close(1000); } catch { /* closed */ } return; }
      if (p.type !== "events_api" || !p.payload?.event) return;
      setState({ ok: true, lastEventAt: Date.now() });
      const before = Object.keys(cur.threads).length;
      void handle(p.payload.event, p.payload.team_id ?? "")
        .then(() => { if (Object.keys(cur.threads).length !== before) void saveCursor().catch(() => {}); })
        .catch((e) => ctx?.log(`inbound message failed: ${e instanceof Error ? e.message : String(e)}`));
    };
    sock.onclose = (ev) => {
      if (ws !== sock || stopped) return;
      ws = undefined;
      setState({ ok: false, detail: `disconnected (${ev.code}); reconnecting` });
      retry = setTimeout(() => void connect(), backoffMs(attempt++));
    };
    sock.onerror = () => {}; // onclose follows
  }

  function close(): void {
    stopped = true;
    clearTimeout(retry);
    const s = ws;
    ws = undefined;
    try { s?.close(1000); } catch { /* already closed */ }
    state = { ...state, ok: false, detail: "stopped" };
  }

  return {
    kind: "slack",
    caps: SLACK_CAPS,
    poll,
    async start(c) {
      ctx = c;
      stopped = false;
      running = mode();
      if (running === "off") { state = { ok: Boolean(token()), detail: "inbound off (config inbound: off)" }; return; }
      if (running === "socket") {
        const refusal = secretRefRefusal(appRef, ORCA_SECRETS);
        if (refusal) throw new Error(`appTokenRef: ${refusal}`);
      }
      if (!token()) throw new Error(`${connection.secretRef ?? "the token variable"} is not set`);
      const auth = await slackRead(token(), "auth.test");
      if (!auth.ok || typeof auth.user_id !== "string") throw new Error(`Slack refused the user token (auth.test: ${auth.error ?? "no user_id"})`);
      me = { team: String(auth.team_id ?? ""), userId: auth.user_id, name: String(auth.user ?? ""), url: String(auth.url ?? "") };
      // The cursor: the threads Orca talks in (both modes) and where each poll stopped. A first start begins now.
      const raw = await c.cursor.get();
      cur = parseCursor(raw, Date.now());
      if (!raw) await saveCursor();
      c.signal.addEventListener("abort", close, { once: true });
      if (running === "socket") await connect();
      else { c.log(`polling every ${pollMs() / 1000}s as ${me.name || me.userId}`); loop(); }
    },
    async stop() { close(); await inFlight?.catch(() => undefined); },
    async send(target: Target, msg: OutboundMessage): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the token variable"} is not set` };
      const text = msg.title || msg.url ? render(msg) : msg.text;
      // A user id (or a list) is a DM (or group DM) to open first. /api/slack's post skips this.
      const opened = opts.openDms === false ? { ok: true as const, channel: target.externalId } : await openConversation(token(), target.externalId);
      if (!opened.ok) return { ok: false, retryable: !FATAL.has(opened.error), ...(opened.retryAfterMs ? { retryAfterMs: opened.retryAfterMs } : {}), error: opened.error };
      // `orca post --reply --thread` in a top-level DM: a thread on the message it answers.
      const ts = threadTs(target.threadId) ?? (msg.thread && msg.replyToExternalMsgId ? msg.replyToExternalMsgId : undefined);
      if (msg.attachments?.length) {
        if (msg.edit) return { ok: false, retryable: false, error: "editing a message to add files is not supported: post a new message instead" };
        const loaded = await loadSlackFiles(msg.attachments);
        if (!Array.isArray(loaded)) return loaded;
        const up = await uploadFiles(token(), loaded, { channel: opened.channel, threadTs: ts, initialComment: text || undefined });
        if (!up.ok) return { ok: false, retryable: !FATAL.has(up.error ?? ""), ...(up.retryAfterMs ? { retryAfterMs: up.retryAfterMs } : {}), error: `${up.error ?? "unknown error"}${missingScopeHint(up)}` };
        // files.completeUploadExternal names no message ts: a brand-new conversation gets no thread
        // key from this send; an existing one (`ts` already known) is kept as given.
        const threadId = target.threadId && (threadTs(target.threadId) || !ts) ? target.threadId : ts ? `${opened.channel}:${ts}` : undefined;
        return { ok: true, ...(threadId ? { threadId } : {}) };
      }
      const r = msg.edit && target.messageId
        ? await slackApi(token(), "chat.update", { channel: opened.channel, ts: target.messageId, text })
        : await slackApi(token(), "chat.postMessage", { channel: opened.channel, text, ...(ts ? { thread_ts: ts } : {}) });
      if (!r.ok) return { ok: false, retryable: !FATAL.has(r.error ?? ""), ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), error: r.error ?? "unknown error" };
      const posted = typeof r.ts === "string" ? r.ts : undefined;
      const channel = typeof r.channel === "string" ? r.channel : opened.channel;
      const threadId = target.threadId && (threadTs(target.threadId) || !ts) ? target.threadId : ts ? `${channel}:${ts}` : posted ? `${channel}:${posted}` : undefined;
      // Replies in a thread Orca posted in reach it with no mention (kept in the cursor).
      if (threadId?.includes(":") && posted) {
        talkIn(threadId, posted);
        if (running !== "off") await saveCursor().catch(() => {});
      }
      return { ok: true, ...(posted ? { externalMsgId: posted } : {}), ...(threadId ? { threadId } : {}) };
    },
    async health() {
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "token"} is not set` };
      if (running !== "off" && ctx) return state;
      const r = await slackRead(token(), "auth.test");
      return r.ok ? { ok: true, detail: `signed in as ${String(r.user ?? "?")}; inbound off` } : { ok: false, detail: r.error };
    },
    async resolveUser(externalId: string) {
      if (!token()) return undefined;
      const name = await nameOf(externalId).catch(() => undefined);
      return name ? { id: externalId, name } : undefined;
    },
  };
}

/** The user-token connection behind /api/slack: "post as me". Not a row — it exists wherever SLACK_TOKEN is set. */
export const USER_CONNECTION: Connection = { id: "slack-user", kind: "slack", name: "Slack (as you)", instance: "*", config: {}, secretRef: "SLACK_TOKEN", enabled: true };

/** /api/slack's post through the adapter: the same body, the same token, the same error text. */
export async function postAsUser(channel: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!userToken()) return { ok: false, error: "SLACK_TOKEN is not set" };
  const r = await slackAdapter(USER_CONNECTION, { openDms: false }).send({ externalId: channel }, { text }, "");
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
