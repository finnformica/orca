// The Discord adapter (docs/research/integrations.md §5, phase 2; setup: docs/integrations/discord.md).
// Two-way and dependency-free: a hand Gateway client over Bun's WebSocket for inbound, REST for
// outbound. The core owns everything else — the gate (link level, the person, the link's repos),
// dedupe, retries, pacing and the thread → workstream map — so this file only speaks Discord.
//
// Inbound: a message that @-mentions the bot (its user or its managed role) in a linked channel (or in a thread of one), or a DM —
// under the link `config.dmLink` names, else the integration's catch-all link ("*"). A thread's messages carry
// `thread` (its channel id) and its PARENT channel as `source.channel`, so the link is the parent's.
// A top-level mention depends on `config.threads`:
// - false (the default, reply in place): `thread` = `<channel id>:<root id>`, the root being the top
//   of the message's Discord reply chain, so several conversations in one channel stay apart. A send
//   to such a key posts in the channel as a Discord reply to the chain's newest message. No thread.
// - true: `thread` = its own message id. Discord gives a thread started from a message that
//   message's id, so once the core accepts the event the adapter opens that thread.
// Outbound: a post to the link's channel, or into `target.threadId`; a first post for a workstream
// (no thread yet) starts its conversation — a thread on itself (threads on) or its own reply chain
// (threads off) — and returns its id, which the core keeps as that workstream's thread on the link.
// `msg.thread` (`orca post --thread`) opens a thread for one post when the default is in place: on
// the mention for a reply in a chain, on the post for a first post. In a thread or a DM it changes
// nothing. The thread's id comes back, so the core moves the conversation (and its workstream) there.
// Edits PATCH the message. A 429 is retryable with Discord's `retry_after`. The bot token is
// `secretRef` (ORCA_SECRET_DISCORD_BOT) — never logged, never in `raw`.
import type { Adapter, AdapterContext, Connection } from "../adapter";
import { clip, inboundEnvelope, type Capabilities, type OutboundMessage, type SendResult, type Target, type Topic } from "../../../shared/integrations";

export const API = "https://discord.com/api/v10";

// Gateway intents: GUILDS (thread parents), GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT
// (privileged: switch it on in the Developer Portal too, or the content arrives empty).
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
/** Close codes no reconnect can fix: bad token, bad or disallowed intents, bad shard/version. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Discord's limits: content is cut at 2000 characters; about 5 messages per 5s per channel. */
// `attachments: false` stays: the core's meaning of the flag is a real `orca-attachment://` ref
// (server/attachments.ts), which this adapter does not produce. A text attachment's content goes
// inline in `text` instead (see `attachmentText`); any other file stays a URL line.
export const DISCORD_CAPS: Capabilities = {
  inbound: "socket", outbound: true, threads: true, edits: true, reactions: false, attachments: false,
  maxTextLength: 2000, rate: { perTarget: 5, windowMs: 5_000 },
};

/** The WebSocket constructor the Gateway uses. A test swaps in a fake server. */
export const gateway = { WebSocket: globalThis.WebSocket as unknown as new (url: string) => WebSocketLike, baseBackoffMs: 1_000 };
export type WebSocketLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
};

type Rest = { ok: boolean; status: number; data: Record<string, unknown>; retryAfterMs?: number; error?: string };

/** One REST call. Never throws: a network error is `status: 0`. Pure I/O. */
export async function discordApi(token: string, method: string, path: string, body?: unknown): Promise<Rest> {
  try {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "DiscordBot (https://github.com/finnformica/orca, 1)" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, status: res.status, data };
    // 429: `retry_after` (seconds, a float) in the body, else the Retry-After header.
    const after = Number(data.retry_after ?? res.headers?.get?.("retry-after"));
    return { ok: false, status: res.status, data, error: `${res.status} ${String(data.message ?? res.statusText ?? "error")}`, ...(after > 0 ? { retryAfterMs: Math.ceil(after * 1000) } : {}) };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A failed call as the core's SendResult: retry a network error, a 429 or a 5xx; never auth, a
 *  missing channel or a bad message. */
export const failure = (r: Rest): SendResult => ({
  ok: false, retryable: r.status === 0 || r.status === 429 || r.status >= 500,
  ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}), error: r.error ?? "unknown error",
});

// The embed style of the build posts in the same server (agency-tooling build-notifications):
// a coloured embed with a linked title. Colour by what happened.
const COLOR = { info: 0x5865f2, warning: 0xfaa61a, grey: 0x99aab5, good: 0x57f287 };
export function colorFor(topic?: Topic): number {
  const t = String(topic ?? "");
  if (/fail|conflict|refused|gave_up|error/.test(t)) return COLOR.warning;
  if (/stopped|cancel/.test(t)) return COLOR.grey;
  if (/merged|ready|finished|done/.test(t)) return COLOR.good;
  return COLOR.info;
}

/** The message body: plain content for a reply (no title), an embed for an event post. Pure. */
export function render(msg: OutboundMessage): Record<string, unknown> {
  if (!msg.title) return { content: msg.url ? `${msg.text}\n${msg.url}` : msg.text, allowed_mentions: { parse: [] } };
  return {
    allowed_mentions: { parse: [] }, // a model's text never pings @everyone or a role
    embeds: [{ title: clip(msg.title, 256), ...(msg.url ? { url: msg.url } : {}), description: clip(msg.text, 4096), color: colorFor(msg.topic), timestamp: new Date().toISOString() }],
  };
}

/** A Gateway MESSAGE_CREATE as the core's envelope, or undefined when it is not for Orca (a bot, an
 *  empty message). `parent` is the channel's parent when it is a thread. Building the text can do
 *  I/O: a download for a text attachment (see `toEnvelope`, `attachmentText`); the reply it quotes
 *  is resolved by the caller (`immediateParent`) and handed in already read. */
export type DiscordAuthor = { id: string; username?: string; global_name?: string | null; bot?: boolean };
export type DiscordAttachment = { url: string; filename?: string; content_type?: string };
export type DiscordMessage = {
  id: string; channel_id: string; guild_id?: string; content?: string; timestamp?: string;
  author: DiscordAuthor;
  mentions?: { id: string }[]; attachments?: DiscordAttachment[];
  /** Role ids the message mentions: the bot's managed role is one way to @-mention it. */
  mention_roles?: string[];
  /** A reply: the message it answers (`type` 0 or absent; 1 is a forward). */
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
  /** The replied-to message, when Discord embedded it (it usually does; absent for an old one, or
   *  one from before the bot joined). */
  referenced_message?: { id: string; content?: string; author?: DiscordAuthor; attachments?: DiscordAttachment[]; message_reference?: DiscordMessage["message_reference"] } | null;
};

/** A reply chain's thread key, `<channel id>:<root message id>`. A Discord thread id has no colon. */
export const chainKey = (channel: string, root: string): string => `${channel}:${root}`;
/** The channel and root of a chain key, or undefined for a thread or DM channel id. Pure. */
export function parseChain(threadId?: string): { channel: string; root: string } | undefined {
  const m = threadId?.match(/^([^:]+):([^:]+)$/);
  return m ? { channel: m[1]!, root: m[2]! } : undefined;
}
/** The id a reply answers, when it is a reply in the same channel (not a forward). Pure. */
const replyOf = (ref: DiscordMessage["message_reference"] | undefined, channel: string): string | undefined =>
  ref?.message_id && (ref.type ?? 0) === 0 && (!ref.channel_id || ref.channel_id === channel) ? ref.message_id : undefined;

/** True when the message @-mentions the bot: its user, or its managed role (`botRole`, the role
 *  Discord's autocomplete offers beside the user, with the same name). Pure. */
export const mentionsBot = (m: Pick<DiscordMessage, "mentions" | "mention_roles" | "content">, botId?: string, botRole?: string): boolean =>
  Boolean(botId && (m.mentions?.some((u) => u.id === botId) || m.content?.includes(`<@${botId}>`)))
  || Boolean(botRole && (m.mention_roles?.includes(botRole) || m.content?.includes(`<@&${botRole}>`)));

/** The bot's managed role in a guild's role list: the one whose `tags.bot_id` is the bot. Pure. */
export const botRoleOf = (roles: unknown, botId?: string): string | undefined =>
  !botId || !Array.isArray(roles) ? undefined
    : (roles as { id?: unknown; tags?: { bot_id?: unknown } }[]).find((r) => r?.tags?.bot_id === botId && typeof r.id === "string")?.id as string | undefined;

/** Attachments whose content is read as text and inlined (point (b) of the reply-and-attachments
 *  fix, docs/integrations/discord.md): Discord's own `content_type`, else a common text extension.
 *  Pure. */
const TEXT_ATTACHMENT_EXT = /\.(txt|md|json|log|csv|ya?ml)$/i;
export function isTextAttachment(a: Pick<DiscordAttachment, "content_type" | "filename">): boolean {
  return Boolean(a.content_type?.startsWith("text/")) || Boolean(a.filename && TEXT_ATTACHMENT_EXT.test(a.filename));
}

/** A text attachment past this size is truncated, with a note saying so. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024;

/** One attachment as inbound text: a text file's content in a fenced block — downloaded here,
 *  since Discord's CDN URLs are signed and expire, so the agent could not fetch one itself later —
 *  else the CDN URL, as before. Never throws: a failed download falls back to the URL line. */
export async function attachmentText(a: DiscordAttachment): Promise<string> {
  const name = a.filename ?? "";
  if (!isTextAttachment(a)) return `(attachment ${name}: ${a.url})`;
  try {
    const r = await fetch(a.url);
    if (!r.ok) return `(attachment ${name}: ${a.url})`;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const over = bytes.byteLength > MAX_ATTACHMENT_BYTES;
    const text = new TextDecoder().decode(over ? bytes.subarray(0, MAX_ATTACHMENT_BYTES) : bytes);
    return `${name}:\n\`\`\`\n${text}${over ? "\n… (truncated at 100 KB)" : ""}\n\`\`\``;
  } catch {
    return `(attachment ${name}: ${a.url})`;
  }
}

/** The message `m` directly replies to: `m.referenced_message` when Discord embedded it (no extra
 *  call, usable whether or not `m` mentions Orca), else one REST read by `message_reference` —
 *  only for a message addressed to Orca (`read`), so chatter costs no call. Shared by the chain-root
 *  walk (`rootOf`, which follows its `message_reference` on up) and the quote `m` adds before its
 *  own text (`quoteText`, which reads its content and attachments) — so a reply resolves its parent
 *  at most once. */
async function immediateParent(m: DiscordMessage, token: string | undefined, read: boolean): Promise<{ content?: string; author?: DiscordAuthor; attachments?: DiscordAttachment[]; message_reference?: DiscordMessage["message_reference"] } | undefined> {
  const ref = replyOf(m.message_reference, m.channel_id);
  if (!ref) return undefined;
  if (m.referenced_message?.id === ref) return m.referenced_message;
  if (!read || !token) return undefined;
  const r = await discordApi(token, "GET", `/channels/${m.channel_id}/messages/${ref}`);
  return r.ok ? (r.data as { content?: string; author?: DiscordAuthor; attachments?: DiscordAttachment[]; message_reference?: DiscordMessage["message_reference"] }) : undefined;
}

/** The replied-to message as quoted text, before the new message's own (point (a) of the
 *  reply-and-attachments fix): its author, text and attachments (inlined the same way as the new
 *  message's, point (b)). `parent` is already resolved (`immediateParent`); undefined when there
 *  is nothing to quote. */
async function quoteText(parent: { content?: string; author?: DiscordAuthor; attachments?: DiscordAttachment[] } | undefined): Promise<string | undefined> {
  if (!parent) return undefined;
  const name = parent.author?.global_name || parent.author?.username || "someone";
  const body = [
    ...(parent.content?.trim() ? parent.content.trim().split("\n") : []),
    ...(await Promise.all((parent.attachments ?? []).map(attachmentText))).flatMap((s) => s.split("\n")),
  ];
  return body.length ? [`> ${name} wrote:`, ...body.map((l) => `> ${l}`)].join("\n") : undefined;
}

export async function toEnvelope(m: DiscordMessage, o: { integrationId: string; botId?: string; botRole?: string; dmLink?: string; parent?: string; threads?: boolean; root?: string; immediate?: { content?: string; author?: DiscordAuthor; attachments?: DiscordAttachment[] } }) {
  if (m.author.bot || (o.botId && m.author.id === o.botId)) return undefined;
  const dm = !m.guild_id;
  const mentioned = dm || mentionsBot(m, o.botId, o.botRole);
  const quote = await quoteText(o.immediate);
  const text = [
    quote,
    (m.content ?? "").replace(new RegExp(`<@!?${o.botId ?? "-"}>`, "g"), "").replace(o.botRole ? new RegExp(`<@&${o.botRole}>`, "g") : /$^/, "").trim(),
    ...(mentioned ? await Promise.all((m.attachments ?? []).map(attachmentText)) : (m.attachments ?? []).map((a) => `(attachment ${a.filename ?? ""}: ${a.url})`)),
  ].filter(Boolean).join("\n");
  if (!text) return undefined;
  // In a thread: the link is the parent's, the thread is this channel. Top level: the thread a reply
  // opens on this message has this message's id, or with threads off the reply chain's key.
  const inThread = !dm && Boolean(o.parent && o.parent !== m.channel_id);
  const topLevel = !dm && !inThread;
  const e = inboundEnvelope({
    adapter: "discord", integrationId: o.integrationId, eventId: m.id,
    // A DM: the link `dmLink` names, else the DM channel itself, which the core matches to the
    // integration's catch-all link ("*") — no such link drops it.
    channel: dm ? (o.dmLink ? undefined : m.channel_id) : inThread ? o.parent : m.channel_id,
    from: { adapter: "discord", id: m.author.id, name: m.author.global_name || m.author.username },
    text, mentioned,
    thread: { adapter: "discord", externalId: !topLevel ? m.channel_id : o.threads ? m.id : chainKey(m.channel_id, o.root ?? m.id), messageId: m.id },
    at: m.timestamp ? Date.parse(m.timestamp) : undefined,
    raw: { id: m.id, channel_id: m.channel_id, guild_id: m.guild_id }, // ids only: no content twice, never a token
  });
  return { envelope: dm && o.dmLink ? { ...e, source: { ...e.source, linkId: o.dmLink } } : e, opensThread: topLevel && Boolean(o.threads) };
}

/** The wait before reconnect number `attempt`: 1s, 2s, 4s … 60s. */
export const backoffMs = (attempt: number): number => Math.min(60_000, gateway.baseBackoffMs * 2 ** attempt);

/** How far up a reply chain the adapter reads (one REST call a hop) before it calls a message the root. */
export const MAX_CHAIN_HOPS = 25;
/** The size of each in-memory map (thread parents, chain roots, newest messages). */
const MAP_CAP = 5_000;
const remember = (map: Map<string, string>, k: string, v: string) => {
  map.delete(k);
  map.set(k, v);
  if (map.size > MAP_CAP) map.delete(map.keys().next().value!);
};

export function discordAdapter(connection: Connection): Adapter {
  const token = () => (connection.secretRef ? process.env[connection.secretRef] : undefined) ?? "";
  const dmLink = typeof connection.config.dmLink === "string" && connection.config.dmLink ? connection.config.dmLink : undefined;
  // Off unless `config.threads` is true (Settings stores the text "true"): Orca answers where it was
  // mentioned (docs/integrations/discord.md).
  const threads = connection.config.threads === true || connection.config.threads === "true";
  let ctx: AdapterContext | undefined;
  let ws: WebSocketLike | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let acked = true;
  let seq: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let gatewayUrl = "wss://gateway.discord.gg";
  let botId: string | undefined;
  let attempt = 0;
  let stopped = false;
  let state: { ok: boolean; detail?: string; lastEventAt?: number } = { ok: false, detail: "not started" };
  const parents = new Map<string, string>(); // thread id → parent channel id
  const roots = new Map<string, string>(); // message id → the root of its reply chain
  const newest = new Map<string, string>(); // chain key → the newest message in the chain
  const botRoles = new Map<string, string>(); // guild id → the bot's managed role id ("" = none)

  /** Open a thread on message `on` in `channel`, named after the post. True when it exists after
   *  (Discord's 160004 = a thread already exists there). */
  async function openThreadOn(channel: string, on: string, msg: OutboundMessage): Promise<boolean> {
    const t = await discordApi(token(), "POST", `/channels/${channel}/messages/${on}/threads`, { name: clip(msg.title || msg.text.split("\n")[0] || "Orca", 90), auto_archive_duration: 1440 });
    if (t.ok || t.data.code === 160004) { parents.set(on, channel); return true; }
    ctx?.log(`could not open a thread on message ${on}: ${t.error}`);
    return false;
  }

  const setState = (s: typeof state) => { state = { ...state, ...s }; void ctx?.status(state).catch(() => {}); };
  const sendOp = (op: number, d: unknown) => { try { ws?.send(JSON.stringify({ op, d })); } catch { /* the close handler reconnects */ } };
  const identify = () => sendOp(2, { token: token(), intents: INTENTS, properties: { os: "linux", browser: "orca", device: "orca" } });

  /** A thread's parent channel: from the Gateway's thread events, else one REST read. A channel that
   *  is not a thread is its own parent. */
  async function parentOf(channelId: string): Promise<string> {
    const known = parents.get(channelId);
    if (known) return known;
    const r = await discordApi(token(), "GET", `/channels/${channelId}`);
    const parent = r.ok && [10, 11, 12].includes(Number(r.data.type)) && typeof r.data.parent_id === "string" ? r.data.parent_id : channelId;
    parents.set(channelId, parent);
    return parent;
  }

  /** The root of a top-level message's reply chain: from the map (Orca's own replies are in it),
   *  else read up the chain by REST, at most MAX_CHAIN_HOPS — only for a message to Orca (`read`),
   *  so chatter costs no calls. `immediate` is the first hop, already resolved by the caller
   *  (`immediateParent`), so it costs no second call here. A message that answers nothing is its
   *  own root. */
  async function rootOf(m: DiscordMessage, read: boolean, immediate: { message_reference?: DiscordMessage["message_reference"] } | undefined): Promise<string> {
    const path = [m.id];
    let ref = replyOf(m.message_reference, m.channel_id);
    let root: string | undefined;
    for (let hop = 0; ref && hop < MAX_CHAIN_HOPS; hop++) {
      root = roots.get(ref);
      if (root) break;
      path.push(ref);
      if (hop === 0) ref = immediate ? replyOf(immediate.message_reference, m.channel_id) : undefined;
      else if (!read) break;
      else {
        const r = await discordApi(token(), "GET", `/channels/${m.channel_id}/messages/${ref}`);
        ref = r.ok ? replyOf(r.data.message_reference as DiscordMessage["message_reference"], m.channel_id) : undefined;
      }
    }
    root ??= path.at(-1)!;
    for (const id of path) remember(roots, id, root);
    return root;
  }

  /** The bot's managed role in a guild: from GUILD_CREATE, else one REST read, kept (a guild with
   *  none is kept as "", so it costs one call). Read only for a message that mentions a role. */
  async function botRoleIn(guildId: string): Promise<string | undefined> {
    if (!botRoles.has(guildId)) {
      const r = await discordApi(token(), "GET", `/guilds/${guildId}/roles`);
      if (!r.ok) return undefined; // not kept: the next role mention reads again
      remember(botRoles, guildId, botRoleOf(r.data, botId) ?? "");
    }
    return botRoles.get(guildId) || undefined;
  }

  async function onMessage(m: DiscordMessage): Promise<void> {
    if (!ctx || m.author.bot) return;
    const parent = m.guild_id ? await parentOf(m.channel_id) : undefined;
    const topLevel = Boolean(m.guild_id) && (!parent || parent === m.channel_id);
    const botRole = m.guild_id && m.mention_roles?.length ? await botRoleIn(m.guild_id) : undefined;
    const mentioned = !m.guild_id || mentionsBot(m, botId, botRole);
    // Resolved once: the chain-root walk and the quote this message adds both need it.
    const immediate = await immediateParent(m, token(), mentioned);
    const root = topLevel && !threads ? await rootOf(m, mentioned, immediate) : undefined;
    const made = await toEnvelope(m, { integrationId: connection.id, botId, botRole, dmLink, parent, threads, root, immediate });
    if (!made) return;
    if (root) remember(newest, chainKey(m.channel_id, root), m.id); // Orca's answer replies to this message
    const verdict = await ctx.ingest(made.envelope);
    if (verdict === "new" && made.opensThread) {
      // The request's thread, named after it. Its id is the message id the envelope already carries.
      const name = clip(made.envelope.text.split("\n")[0] || "Orca", 90);
      const r = await discordApi(token(), "POST", `/channels/${m.channel_id}/messages/${m.id}/threads`, { name, auto_archive_duration: 1440 });
      if (r.ok) parents.set(m.id, m.channel_id);
      else ctx.log(`could not open a thread on message ${m.id}: ${r.error}`);
    }
  }

  function connect(): void {
    if (stopped) return;
    const url = `${resumeUrl && sessionId ? resumeUrl : gatewayUrl}/?v=10&encoding=json`;
    const sock = new gateway.WebSocket(url);
    ws = sock;
    sock.onmessage = (ev) => {
      let p: { op: number; d: any; s?: number | null; t?: string | null };
      try { p = JSON.parse(String(ev.data)); } catch { return; }
      if (typeof p.s === "number") seq = p.s;
      if (p.op === 10) { // Hello: beat, then identify or resume
        clearInterval(beat);
        acked = true;
        const every = Number(p.d?.heartbeat_interval) || 41_250;
        beat = setInterval(() => {
          if (!acked) { sock.close(4000); return; } // a zombie connection: drop it and resume
          acked = false;
          sendOp(1, seq);
        }, every);
        if (sessionId) sendOp(6, { token: token(), session_id: sessionId, seq });
        else identify();
      } else if (p.op === 11) acked = true;
      else if (p.op === 1) sendOp(1, seq);
      else if (p.op === 7) sock.close(4000); // Reconnect: resume on a new socket
      else if (p.op === 9) { // Invalid session: resumable (d true) or start a new one
        if (!p.d) { sessionId = undefined; resumeUrl = undefined; seq = null; }
        setTimeout(() => stopped || (p.d ? sendOp(6, { token: token(), session_id: sessionId, seq }) : identify()), 1_000 + Math.random() * 4_000);
      } else if (p.op === 0) {
        const at = Date.now();
        if (p.t === "READY") {
          sessionId = p.d.session_id; resumeUrl = p.d.resume_gateway_url; botId = p.d.user?.id;
          attempt = 0;
          setState({ ok: true, detail: `connected as ${p.d.user?.username ?? "?"}` });
        } else if (p.t === "RESUMED") { attempt = 0; setState({ ok: true }); }
        else if (p.t === "GUILD_CREATE") {
          for (const t of p.d?.threads ?? []) parents.set(t.id, t.parent_id);
          if (p.d?.id && Array.isArray(p.d.roles)) remember(botRoles, p.d.id, botRoleOf(p.d.roles, botId) ?? "");
        } else if (p.t === "GUILD_ROLE_CREATE" || p.t === "GUILD_ROLE_UPDATE") {
          if (p.d?.guild_id && botRoleOf([p.d.role], botId)) remember(botRoles, p.d.guild_id, p.d.role.id);
        }
        else if (p.t === "THREAD_CREATE" || p.t === "THREAD_UPDATE") { if (p.d?.parent_id) parents.set(p.d.id, p.d.parent_id); }
        else if (p.t === "MESSAGE_CREATE") {
          setState({ ok: true, lastEventAt: at });
          void onMessage(p.d as DiscordMessage).catch((e) => ctx?.log(`inbound message failed: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    };
    sock.onclose = (ev) => {
      clearInterval(beat);
      if (ws !== sock || stopped) return;
      if (FATAL_CLOSE.has(ev.code)) {
        setState({ ok: false, detail: `Discord closed the Gateway (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}); check the token and the Message Content intent` });
        return;
      }
      if (ev.code === 4007 || ev.code === 4009) { sessionId = undefined; resumeUrl = undefined; seq = null; } // the session can't be resumed
      setState({ ok: false, detail: `disconnected (${ev.code}); reconnecting` });
      retry = setTimeout(connect, backoffMs(attempt++));
    };
    sock.onerror = () => {}; // onclose follows
  }

  function close(): void {
    stopped = true;
    clearInterval(beat);
    clearTimeout(retry);
    const s = ws;
    ws = undefined;
    try { s?.close(1000); } catch { /* already closed */ }
    state = { ...state, ok: false, detail: "stopped" };
  }

  return {
    kind: "discord",
    caps: DISCORD_CAPS,
    async start(c) {
      ctx = c;
      stopped = false;
      if (!token()) throw new Error(`${connection.secretRef ?? "the token variable"} is not set`);
      // Checks the token before a socket is opened: a bad one fails the start, as the contract asks.
      const r = await discordApi(token(), "GET", "/gateway/bot");
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error(`Discord refused the bot token (${r.error})`);
        c.log(`could not read the Gateway URL (${r.error}); using the default`);
      } else if (typeof r.data.url === "string") gatewayUrl = r.data.url;
      c.signal.addEventListener("abort", close);
      connect();
    },
    async stop() { close(); },
    async send(target: Target, msg: OutboundMessage): Promise<SendResult> {
      if (!token()) return { ok: false, retryable: false, error: `${connection.secretRef ?? "the token variable"} is not set` };
      const chain = parseChain(target.threadId);
      // A Discord thread is a channel; a reply chain lives in its channel.
      const channel = chain?.channel ?? target.threadId ?? target.externalId;
      const body = render(msg);
      if (msg.edit && target.messageId) {
        const r = await discordApi(token(), "PATCH", `/channels/${channel}/messages/${target.messageId}`, body);
        return r.ok ? { ok: true, externalMsgId: target.messageId, ...(target.threadId ? { threadId: target.threadId } : {}) } : failure(r);
      }
      if (chain && msg.thread) {
        // `orca post --reply --thread`: a thread on the mention (else the chain's newest message), and
        // the answer in it. The thread's id is that message's id: the conversation moves there.
        const on = msg.replyToExternalMsgId ?? newest.get(chainKey(chain.channel, chain.root)) ?? chain.root;
        if (await openThreadOn(chain.channel, on, msg)) {
          const r = await discordApi(token(), "POST", `/channels/${on}/messages`, body);
          if (!r.ok) return failure(r);
          return { ok: true, ...(typeof r.data.id === "string" ? { externalMsgId: r.data.id } : {}), threadId: on };
        }
        // No thread (no permission, a deleted message): the answer stays in place.
      }
      if (chain) {
        // Reply in place: a Discord reply to the chain's newest message. A deleted one makes it a plain post.
        const key = chainKey(chain.channel, chain.root);
        const r = await discordApi(token(), "POST", `/channels/${chain.channel}/messages`, {
          ...body, message_reference: { message_id: newest.get(key) ?? chain.root, fail_if_not_exists: false },
        });
        if (!r.ok) return failure(r);
        const id = typeof r.data.id === "string" ? r.data.id : undefined;
        if (id) { remember(roots, id, chain.root); remember(newest, key, id); }
        return { ok: true, ...(id ? { externalMsgId: id } : {}), threadId: target.threadId! };
      }
      let r = await discordApi(token(), "POST", `/channels/${channel}/messages`, body);
      // A thread id that is a message id in the link's channel names a thread nobody opened yet: the
      // core's pairing reply to a new sender, or `orca post --thread` after the open at ingest failed.
      // Threads on: open it on that message, then post again (Discord's 160004 = a thread already
      // exists there). Threads off: reply to that message in the channel instead.
      if (!r.ok && r.status === 404 && !threads && target.threadId && target.threadId !== target.externalId) {
        r = await discordApi(token(), "POST", `/channels/${target.externalId}/messages`, { ...body, message_reference: { message_id: target.threadId, fail_if_not_exists: false } });
        if (!r.ok) return failure(r);
        return { ok: true, ...(typeof r.data.id === "string" ? { externalMsgId: r.data.id } : {}), threadId: target.threadId };
      }
      if (!r.ok && r.status === 404 && threads && target.threadId && target.threadId !== target.externalId) {
        const t = await discordApi(token(), "POST", `/channels/${target.externalId}/messages/${target.threadId}/threads`, { name: clip(msg.title || msg.text.split("\n")[0] || "Orca", 90), auto_archive_duration: 1440 });
        if (t.ok || t.data.code === 160004) {
          parents.set(target.threadId, target.externalId);
          r = await discordApi(token(), "POST", `/channels/${channel}/messages`, body);
        }
      }
      if (!r.ok) return failure(r);
      const id = typeof r.data.id === "string" ? r.data.id : undefined;
      if (target.threadId || !id) return { ok: true, ...(id ? { externalMsgId: id } : {}), ...(target.threadId ? { threadId: target.threadId } : {}) };
      // A first post for this workstream on the link: the post starts its conversation, so the next
      // posts and the replies stay together. Threads off: its reply chain. Threads on, or `--thread`:
      // a thread on the post; the post itself stands if Discord refuses the thread.
      if (!threads && !msg.thread) {
        remember(roots, id, id);
        remember(newest, chainKey(target.externalId, id), id);
        return { ok: true, externalMsgId: id, threadId: chainKey(target.externalId, id) };
      }
      if (await openThreadOn(target.externalId, id, msg)) return { ok: true, externalMsgId: id, threadId: id };
      if (threads) return { ok: true, externalMsgId: id };
      remember(roots, id, id);
      remember(newest, chainKey(target.externalId, id), id);
      return { ok: true, externalMsgId: id, threadId: chainKey(target.externalId, id) };
    },
    async health() {
      if (!token()) return { ok: false, detail: `${connection.secretRef ?? "token"} is not set` };
      return state;
    },
    async resolveUser(externalId: string) {
      const r = await discordApi(token(), "GET", `/users/${externalId}`);
      if (!r.ok || typeof r.data.id !== "string") return undefined;
      return { id: r.data.id, name: String(r.data.global_name || r.data.username || r.data.id) };
    },
  };
}
