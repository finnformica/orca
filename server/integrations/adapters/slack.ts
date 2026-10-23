// The Slack adapter (docs/research/integrations.md §5; setup: docs/integrations/slack.md). Two-way,
// as YOU: the row's token is a user token (`xoxp`, SLACK_TOKEN), so every post is in your name, and
// the events are your own (Slack's user event subscriptions). Dependency-free: Socket Mode is a hand
// client over Bun's WebSocket, like adapters/discord.ts; the Web API is plain `fetch`.
//
// OUTBOUND: `chat.postMessage` (a thread reply with `thread_ts`, thread id `channel:thread_ts`),
// `chat.update` for an edit, the retryable/fatal split and a 1-per-second pace per channel. A target
// that is a user id (`U…`) or a list of them (`U1,U2`) is a DM or group DM: `conversations.open`
// gives its channel first. `postMessage` / `postAsUser` keep /api/slack's post exactly as it was.
//
// INBOUND (Socket Mode): the app-level token (`xapp`, the variable `config.appTokenRef` names,
// default SLACK_APP_TOKEN) opens the socket through `apps.connections.open`. Every envelope is acked
// at once. Unset, inbound stays off and the adapter only posts. A `message` event becomes one
// envelope when another person wrote it and it is one of:
// - a mention of you (`<@you>`) in a channel or private channel;
// - a DM to you (source channel `D…`, parent `im`) or a group DM (parent `mpim`);
// - a reply in a thread Orca already talks in (a mention came there, or Orca posted there).
// Your own messages never count, so a post Orca makes as you never comes back in. The thread is
// `channel:thread_ts` (a channel mention starts one on itself); a top-level DM is the DM channel
// itself, so the answer goes in the DM, not in a thread. Tokens are never logged, never in `raw`.
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { ORCA_SECRETS } from "../../env";
import { inboundEnvelope, secretRefRefusal, type Capabilities, type InboundEnvelope, type OutboundMessage, type SendResult, type Target } from "../../../shared/integrations";

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

export const SLACK_CAPS: Capabilities = {
  inbound: "socket", outbound: true, threads: true, edits: true, reactions: false, attachments: false,
  maxTextLength: 39_000, rate: { perTarget: 1, windowMs: 1_000 },
};

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

/** One Socket Mode `message` event as the core's envelope, or undefined when it is not for Orca. Pure.
 *  `me` is the token's own user; `known` says whether Orca already talks in a thread key. */
export function slackInbound(ev: SlackEvent, me: { team: string; userId: string; name?: string; integrationId: string }, o: { known?: (threadKey: string) => boolean; senderName?: string } = {}): InboundEnvelope | undefined {
  if (ev.type !== "message") return undefined;
  if (!PERSON_SUBTYPES.has(ev.subtype ?? "") || ev.bot_id || !ev.user || ev.user === me.userId) return undefined;
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
  // A DM's or group DM's channel id is new for each person: a link on `im` / `mpim` takes them all.
  return place === "channel" ? e : { ...e, source: { ...e.source, parents: [place === "im" ? DM_PLACE : GROUP_DM_PLACE] } };
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

/** The size of each in-memory map (thread keys Orca talks in, user names). */
const MAP_CAP = 5_000;
const remember = <V>(map: Map<string, V>, k: string, v: V) => {
  map.delete(k);
  map.set(k, v);
  if (map.size > MAP_CAP) map.delete(map.keys().next().value!);
};

export function slackAdapter(connection: Connection, opts: { openDms?: boolean } = {}): Adapter {
  const token = () => (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  const appRef = typeof connection.config.appTokenRef === "string" && connection.config.appTokenRef ? connection.config.appTokenRef : APP_TOKEN_REF;
  const appToken = () => process.env[appRef] ?? "";
  // Inbound is on unless `config.socket` is false (Settings stores the text "false").
  const socketOff = connection.config.socket === false || connection.config.socket === "false";
  let ctx: AdapterContext | undefined;
  let ws: WebSocketLike | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  let inbound = false;
  let me = { team: "", userId: "", name: "" };
  let state: { ok: boolean; detail?: string; lastEventAt?: number } = { ok: false, detail: "not started" };
  const threads = new Map<string, true>(); // thread keys Orca talks in: a reply there needs no mention
  const names = new Map<string, string>(); // user id → display name

  const setState = (s: typeof state) => { state = { ...state, ...s }; void ctx?.status(state).catch(() => {}); };

  async function nameOf(user: string): Promise<string | undefined> {
    const known = names.get(user);
    if (known !== undefined) return known || undefined;
    const r = await slackRead(token(), "users.info", { user });
    const u = r.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
    const name = r.ok ? u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || "" : "";
    if (r.ok) remember(names, user, name); // a failed read is not kept: the next message reads again
    return name || undefined;
  }

  async function onEvent(ev: SlackEvent, team: string): Promise<void> {
    if (!ctx || ev.type !== "message" || !ev.user || ev.user === me.userId) return;
    const made = slackInbound(ev, { team: team || me.team, userId: me.userId, name: me.name, integrationId: connection.id }, { known: (k) => threads.has(k) });
    if (!made) return;
    const senderName = await nameOf(ev.user).catch(() => undefined);
    const e = senderName ? { ...made, actor: { external: { ...made.actor!.external, name: senderName } } } : made;
    const verdict = await ctx.ingest(e);
    if (verdict === "new" && e.thread) remember(threads, e.thread.externalId, true);
  }

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
      void onEvent(p.payload.event, p.payload.team_id ?? "").catch((e) => ctx?.log(`inbound message failed: ${e instanceof Error ? e.message : String(e)}`));
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
    async start(c) {
      ctx = c;
      stopped = false;
      // Inbound needs the app-level token. Without it the adapter only posts: no error, no socket.
      if (socketOff || !appToken()) {
        inbound = false;
        state = { ok: Boolean(token()), detail: socketOff ? "inbound off (config socket: false)" : `inbound off: ${appRef} is not set` };
        return;
      }
      const refusal = secretRefRefusal(appRef, ORCA_SECRETS);
      if (refusal) throw new Error(`appTokenRef: ${refusal}`);
      if (!token()) throw new Error(`${connection.secretRef ?? "the token variable"} is not set`);
      const auth = await slackRead(token(), "auth.test");
      if (!auth.ok || typeof auth.user_id !== "string") throw new Error(`Slack refused the user token (auth.test: ${auth.error ?? "no user_id"})`);
      me = { team: String(auth.team_id ?? ""), userId: auth.user_id, name: String(auth.user ?? "") };
      inbound = true;
      c.signal.addEventListener("abort", close, { once: true });
      await connect();
    },
    async stop() { close(); },
    async send(target: Target, msg: OutboundMessage): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the token variable"} is not set` };
      const text = msg.title || msg.url ? render(msg) : msg.text;
      // A user id (or a list) is a DM (or group DM) to open first. /api/slack's post skips this.
      const opened = opts.openDms === false ? { ok: true as const, channel: target.externalId } : await openConversation(token(), target.externalId);
      if (!opened.ok) return { ok: false, retryable: !FATAL.has(opened.error), ...(opened.retryAfterMs ? { retryAfterMs: opened.retryAfterMs } : {}), error: opened.error };
      // `orca post --reply --thread` in a top-level DM: a thread on the message it answers.
      const ts = threadTs(target.threadId) ?? (msg.thread && msg.replyToExternalMsgId ? msg.replyToExternalMsgId : undefined);
      const r = msg.edit && target.messageId
        ? await slackApi(token(), "chat.update", { channel: opened.channel, ts: target.messageId, text })
        : await slackApi(token(), "chat.postMessage", { channel: opened.channel, text, ...(ts ? { thread_ts: ts } : {}) });
      if (!r.ok) return { ok: false, retryable: !FATAL.has(r.error ?? ""), ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), error: r.error ?? "unknown error" };
      const posted = typeof r.ts === "string" ? r.ts : undefined;
      const channel = typeof r.channel === "string" ? r.channel : opened.channel;
      const threadId = target.threadId && (threadTs(target.threadId) || !ts) ? target.threadId : ts ? `${channel}:${ts}` : posted ? `${channel}:${posted}` : undefined;
      // Replies in a thread Orca posted in reach it with no mention.
      if (threadId) remember(threads, threadId, true);
      return { ok: true, ...(posted ? { externalMsgId: posted } : {}), ...(threadId ? { threadId } : {}) };
    },
    async health() {
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "token"} is not set` };
      if (inbound && ctx) return state;
      const r = await slackRead(token(), "auth.test");
      const off = socketOff ? "inbound off (config socket: false)" : `inbound off: ${appRef} is not set`;
      return r.ok ? { ok: true, detail: `signed in as ${String(r.user ?? "?")}; ${off}` } : { ok: false, detail: r.error };
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
