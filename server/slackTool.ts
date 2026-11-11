// `orca slack …`: the orchestrator reads and writes Slack AS THE USER (docs/integrations/slack.md).
// The bridge calls the Web API with the user token (`SLACK_TOKEN`, xoxp — in env.ts ORCA_SECRETS, so
// no agent sees it), read here per call and never printed or logged. `bin/orca` only talks to the
// bridge, like every other verb. The grant check (shared/integrations.ts grantRefusal) keeps every
// `orca slack` verb to the user's own chat: an outside sender answers with `orca post --reply`.
//
//   orca slack conversations [--types im,mpim,public,private] [--limit 100]
//   orca slack read <target> [--thread <ts>] [--limit 20]
//   orca slack search "<query>" [--limit 20]
//   orca slack post <target> [--thread <ts>] [--attach <id|path>]... "<text>"
//   orca slack file <file id> [--out <dir>] [--account <name>]
//
// A target is a channel id (C…, G…, D…), `#name`, a user id (U…) or `@name` (a DM), or a comma list
// of users (a group DM). A post is logged as one `[slack]` line with the place and the ts, never the text.
// `read` and `search` print each message's files underneath it (id, name, mimetype, size); `file`
// fetches one of them — `files.info` then `url_private_download` with the Bearer token — and stores
// it as an Orca attachment, the same shape as `orca gmail attachment` (server/gmailTool.ts). `post
// --attach` uploads one the other way (`uploadFiles`, server/integrations/adapters/slack.ts): Slack's
// two-step external upload, with the text as the files' initial_comment, so they land as one message.
import { mkdirSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import * as db from "./db";
import { ATTACHMENT_PREFIX, forward, materialise, MAX_ATTACHMENT_BYTES, store } from "./attachments";
import { scrubAll } from "./secrets";
import { openConversation, SLACK_CAPS, slackApi, slackRead, uploadFiles, type SlackResult, type SlackUploadFile } from "./integrations/adapters/slack";
import { attachmentIdOf, attachmentRefusal, type VerbClasses } from "../shared/integrations";

type Args = Record<string, unknown> & { _?: unknown[] };
export type SlackToolOpts = { env?: Record<string, string | undefined>; log?: (line: string) => void; by?: string };

export const SLACK_USAGE = [
  "orca slack conversations [--types im,mpim,public,private] [--limit 100]   the conversations you are in",
  "orca slack read <target> [--thread <ts>] [--limit 20]   recent messages, oldest first (a thread with --thread)",
  "orca slack search \"<query>\" [--limit 20]   search every message you can see (Slack search syntax: in:#eng from:@ana)",
  "orca slack post <target> [--thread <ts>] [--attach <id|path>]... \"<text>\"   post as the user;",
  "   --attach (repeatable) uploads each file with the text as its comment, so they land as one message",
  "orca slack file <file id> [--out <dir>] [--account <name>]   save one file (listed under a message in",
  "   read or search) as an Orca attachment (orca send --attach <id>); --out also copies it to that directory",
  "A target is a channel id (C…, G…, D…), #name, a user id (U…) or @name (a DM), or a comma list of users (a group DM).",
  "With more than one Slack account connected, name one: --account <id or name>.",
].join("\n");

/** The class of each `orca slack` verb, for the account policy (docs/integrations/POLICY.md). */
export const SLACK_VERBS: VerbClasses = { help: "read", conversations: "read", read: "read", search: "read", post: "write", file: "read" };

/** A worker only ever hands this file on as a reference, never runs it; the cap is the general
 *  upload cap (attachments.ts), so `attachments.store` never throws a cap it did not check first. */
export const ATTACHMENT_MAX_BYTES = MAX_ATTACHMENT_BYTES;

export class SlackToolError extends Error {}

const fail = (what: string, r: SlackResult): never => {
  const scope = r.error === "missing_scope" && typeof r.needed === "string" ? ` (the user token needs the scope ${r.needed}; see docs/integrations/slack.md)` : "";
  throw new SlackToolError(`${what}: ${r.error ?? "unknown error"}${scope}`);
};

const MAX_PAGES = 20;
/** users.list, cached for ten minutes: `@name` lookups. */
let userCache: { at: number; token: string; users: SlackUser[] } | undefined;
const USER_CACHE_MS = 10 * 60_000;
type SlackUser = { id: string; name?: string; real_name?: string; deleted?: boolean; profile?: { display_name?: string; real_name?: string } };
const displayName = (u: SlackUser): string => u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;

/** Forget the users.list cache (tests). */
export const resetSlackToolCache = (): void => { userCache = undefined; };

async function allUsers(token: string): Promise<SlackUser[]> {
  if (userCache && userCache.token === token && Date.now() - userCache.at < USER_CACHE_MS) return userCache.users;
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await slackRead(token, "users.list", { limit: 200, cursor });
    if (!r.ok) fail("users.list", r);
    users.push(...((r.members as SlackUser[] | undefined) ?? []));
    cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) break;
  }
  userCache = { at: Date.now(), token, users };
  return users;
}

/** A user id for `@name`: the handle, the display name or the real name, case-insensitive. */
async function userIdOf(token: string, name: string): Promise<string> {
  const want = name.replace(/^@/, "").trim().toLowerCase();
  const live = (await allUsers(token)).filter((u) => !u.deleted);
  const hit = live.find((u) => u.name?.toLowerCase() === want)
    ?? live.find((u) => u.profile?.display_name?.toLowerCase() === want)
    ?? live.find((u) => (u.profile?.real_name ?? u.real_name)?.toLowerCase() === want);
  if (!hit) throw new SlackToolError(`no Slack user "${name}" (try the user id, U…)`);
  return hit.id;
}

type Conversation = { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string };

async function conversationsOf(token: string, types: string, limit: number): Promise<Conversation[]> {
  const out: Conversation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
    const r = await slackRead(token, "users.conversations", { types, limit: 200, exclude_archived: true, cursor });
    if (!r.ok) fail("users.conversations", r);
    out.push(...((r.channels as Conversation[] | undefined) ?? []));
    cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out.slice(0, limit);
}

/** The channel id of a target (see the file comment). A DM or group DM is opened (im:write, mpim:write). */
export async function resolveTarget(token: string, target: string): Promise<string> {
  const t = target.trim();
  if (!t) throw new SlackToolError("a target is required (a channel id, #name, a user id or @name)");
  if (/^[CGD][A-Z0-9]+$/.test(t)) return t;
  if (t.startsWith("#")) {
    const want = t.slice(1).toLowerCase();
    const hit = (await conversationsOf(token, "public_channel,private_channel", 5_000)).find((c) => c.name?.toLowerCase() === want);
    if (!hit) throw new SlackToolError(`no channel ${t} that you are in (orca slack conversations lists them)`);
    return hit.id;
  }
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  const ids = await Promise.all(parts.map((p) => (/^[UW][A-Z0-9]+$/.test(p) ? p : userIdOf(token, p))));
  const opened = await openConversation(token, ids.join(","));
  if (!opened.ok) fail("conversations.open", { ok: false, error: opened.error });
  return (opened as { channel: string }).channel;
}

const clampLimit = (v: unknown, dflt: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};
/** A ts from `--thread`: a ts, or a thread key `channel:ts`. */
const tsOf = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  const ts = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
  return ts || undefined;
};
const when = (ts?: string): string => (Number(ts) ? new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ") : "?");
const unescape = (t: string): string => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const indent = (t: string): string => unescape(t).split("\n").map((l) => `    ${l}`).join("\n");
const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/** A file on a Slack message (`conversations.history`/`.replies` and `search.messages` carry this
 *  array on a message with an attached file). */
type SlackFile = { id: string; name?: string; mimetype?: string; size?: number; url_private_download?: string };

/** The file lines printed under a message: id, name, mimetype, size — one per file, indented like
 *  the message text. Empty when the message has none. */
const fileLines = (files?: SlackFile[]): string => (files?.length
  ? `\n${files.map((f) => `    file: ${[f.id, f.name, f.mimetype, typeof f.size === "number" ? kb(f.size) : undefined].filter(Boolean).join(" · ")}`).join("\n")}`
  : "");

/** Display names for user ids: users.info for each one not seen, at most once per call. */
async function namesFor(token: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cached = userCache?.token === token ? new Map(userCache.users.map((u) => [u.id, displayName(u)])) : undefined;
  await Promise.all([...new Set(ids)].map(async (id) => {
    const known = cached?.get(id);
    if (known) { out.set(id, known); return; }
    const r = await slackRead(token, "users.info", { user: id });
    if (r.ok && r.user) out.set(id, displayName(r.user as SlackUser));
  }));
  return out;
}

type Msg = { ts?: string; user?: string; bot_id?: string; username?: string; text?: string; thread_ts?: string; reply_count?: number; subtype?: string; files?: SlackFile[] };

async function conversations(token: string, args: Args): Promise<string> {
  const map: Record<string, string> = { im: "im", mpim: "mpim", public: "public_channel", private: "private_channel" };
  const raw = typeof args.types === "string" && args.types ? args.types : "public,private,im,mpim";
  const types = raw.split(",").map((t) => map[t.trim()] ?? t.trim()).join(",");
  const list = await conversationsOf(token, types, clampLimit(args.limit, 100, 1_000));
  if (!list.length) return "no conversations";
  const names = await namesFor(token, list.filter((c) => c.is_im && c.user).map((c) => c.user!));
  return list.map((c) => c.is_im ? `${c.id} · DM · @${names.get(c.user!) ?? c.user}`
    : c.is_mpim ? `${c.id} · group DM · ${c.name ?? ""}`
    : `${c.id} · ${c.is_private ? "private" : "public"} · #${c.name ?? "?"}`).join("\n");
}

async function read(token: string, words: string[], args: Args): Promise<string> {
  const channel = await resolveTarget(token, words[1] ?? "");
  const limit = clampLimit(args.limit, 20, 200);
  const thread = tsOf(args.thread);
  const r = thread
    ? await slackRead(token, "conversations.replies", { channel, ts: thread, limit })
    : await slackRead(token, "conversations.history", { channel, limit });
  if (!r.ok) fail(thread ? "conversations.replies" : "conversations.history", r);
  let msgs = ((r.messages as Msg[] | undefined) ?? []).filter((m) => !m.subtype || m.subtype === "thread_broadcast" || m.subtype === "file_share");
  // history is newest first; replies is oldest first. Print oldest first either way.
  if (!thread) msgs = msgs.reverse();
  if (!msgs.length) return `no messages in ${channel}${thread ? ` thread ${thread}` : ""}`;
  const names = await namesFor(token, msgs.flatMap((m) => (m.user ? [m.user] : [])));
  return [`${channel}${thread ? ` thread ${thread}` : ""} · ${msgs.length} message${msgs.length === 1 ? "" : "s"}, oldest first`, ...msgs.map((m) => {
    const who = m.user ? `${names.get(m.user) ?? m.user} (${m.user})` : m.username ?? m.bot_id ?? "?";
    const replies = !thread && m.reply_count ? ` · thread: ${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"} (--thread ${m.ts})` : "";
    return `${when(m.ts)} · ${who} · ts ${m.ts}${replies}\n${indent(m.text ?? "")}${fileLines(m.files)}`;
  })].join("\n");
}

type Match = { ts?: string; text?: string; user?: string; username?: string; permalink?: string; channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean }; files?: SlackFile[] };

async function search(token: string, words: string[], args: Args): Promise<string> {
  const query = words.slice(1).join(" ").trim();
  if (!query) throw new SlackToolError('the query is required: orca slack search "<query>"');
  const r = await slackRead(token, "search.messages", { query, count: clampLimit(args.limit, 20, 100), sort: "timestamp", sort_dir: "desc" });
  if (!r.ok) fail("search.messages", r);
  const matches = ((r.messages as { matches?: Match[]; total?: number } | undefined)?.matches) ?? [];
  if (!matches.length) return `no messages match "${query}"`;
  const total = (r.messages as { total?: number }).total ?? matches.length;
  return [`${matches.length} of ${total} match${total === 1 ? "" : "es"} for "${query}", newest first`, ...matches.map((m) => {
    const place = m.channel?.is_im ? `DM ${m.channel.id}` : m.channel?.is_mpim ? `group DM ${m.channel.id}` : `#${m.channel?.name ?? "?"} ${m.channel?.id ?? ""}`.trim();
    return `${when(m.ts)} · ${place} · ${m.username ?? m.user ?? "?"} · ts ${m.ts}${m.permalink ? ` · ${m.permalink}` : ""}\n${indent(m.text ?? "")}${fileLines(m.files)}`;
  })].join("\n");
}

/** `--attach <id|path>` (repeatable): each resolved to a stored attachment the way `orca send
 *  --attach` does (an id, or a file on this machine), then read back as bytes ready to upload. */
async function attachArgs(args: Args): Promise<SlackUploadFile[]> {
  const raw = args.attach === undefined ? [] : Array.isArray(args.attach) ? args.attach : [args.attach];
  const files: SlackUploadFile[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !v.trim()) throw new SlackToolError("--attach needs a value: an attachment id or a file path");
    const ref = await forward(v);
    const row = await db.attachment(attachmentIdOf(ref)!);
    if (!row) throw new SlackToolError(`attachment ${ref} is gone (pruned after 30 days, or never stored)`);
    files.push({ name: row.filename, type: row.mimeType || "application/octet-stream", bytes: row.bytes });
  }
  return files;
}

async function post(token: string, words: string[], args: Args, opts: SlackToolOpts): Promise<string> {
  const target = words[1] ?? "";
  // A stored secret value never leaves through a channel, a public one included (server/secrets.ts).
  const text = scrubAll(words.slice(2).join(" ").trim());
  const files = await attachArgs(args);
  if (!target || (!text && !files.length)) throw new SlackToolError('usage: orca slack post <target> [--thread <ts>] [--attach <id|path>]... "<text>"');
  const channel = await resolveTarget(token, target);
  const thread = tsOf(args.thread);
  const log = opts.log ?? ((l: string) => console.log(l));
  if (files.length) {
    const refusal = attachmentRefusal("slack", SLACK_CAPS, files.map((f) => ({ name: f.name, bytes: f.bytes.byteLength })));
    if (refusal) throw new SlackToolError(refusal);
    const r = await uploadFiles(token, files, { channel, threadTs: thread, initialComment: text || undefined });
    if (!r.ok) fail("files upload", r);
    log(`[slack] ${new Date().toISOString()} ${opts.by ?? "orchestrator"}: post ${files.length} file${files.length === 1 ? "" : "s"} to ${channel}${thread ? ` thread ${thread}` : ""}`);
    return `Posted ${files.length} file${files.length === 1 ? "" : "s"} to ${channel} as the user${thread ? ` in thread ${thread}` : ""}${text ? ", with the text as the comment" : ""}.`;
  }
  const r = await slackApi(token, "chat.postMessage", { channel, text, ...(thread ? { thread_ts: thread } : {}) });
  if (!r.ok) fail("chat.postMessage", r);
  const ts = typeof r.ts === "string" ? r.ts : "?";
  const at = typeof r.channel === "string" ? r.channel : channel;
  // Who and where, never the text.
  log(`[slack] ${new Date().toISOString()} ${opts.by ?? "orchestrator"}: post to ${at}${thread ? ` thread ${thread}` : ""} → ts ${ts}`);
  return `Posted to ${at} as the user${thread ? ` in thread ${thread}` : ""} (ts ${ts}). Reply in its thread with --thread ${thread ?? ts}.`;
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 120) || "file";

const MAX_REDIRECTS = 5;

/** The file's bytes from `url_private_download`, with the Bearer token. Slack's CDN may redirect
 *  once; a redirect to another host is refused (no token leak off Slack's own domain). An HTML body
 *  means the token could not read the file (a sign-in page), not file bytes. */
async function downloadSlackFile(url: string, token: string): Promise<Uint8Array> {
  const host = new URL(url).host;
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(current, { redirect: "manual", headers: { authorization: `Bearer ${token}` } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new SlackToolError(`the download redirected (http ${res.status}) with no location`);
      const next = new URL(loc, current);
      if (next.host !== host) throw new SlackToolError(`the download redirected off ${host} to ${next.host}; refused`);
      current = next.toString();
      continue;
    }
    if (!res.ok) throw new SlackToolError(`the download failed: http ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      throw new SlackToolError("Slack sent a web page instead of the file: the user token cannot read it (the user token needs the scope files:read; see docs/integrations/slack.md)");
    }
    return bytes;
  }
  throw new SlackToolError("too many redirects downloading the file");
}

/** `orca slack file <file id> [--out <dir>]`: `files.info` for the file's name, type and size, then
 *  its bytes from `url_private_download`, stored as an Orca attachment (the same shape as
 *  `orca gmail attachment`, server/gmailTool.ts), so a worker can take it with `orca send --attach <id>`. */
async function file(token: string, words: string[], args: Args): Promise<string> {
  const id = words[1]?.trim();
  if (!id) throw new SlackToolError(`file needs a file id (from a file line under a message in orca slack read or search).\n${SLACK_USAGE}`);
  const r = await slackRead(token, "files.info", { file: id });
  if (!r.ok) fail("files.info", r);
  const f = r.file as SlackFile | undefined;
  if (!f?.id) throw new SlackToolError(`file ${id} not found`);
  if (typeof f.size === "number" && f.size > ATTACHMENT_MAX_BYTES) throw new SlackToolError(`${f.name ?? id} is ${kb(f.size)}, over the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB cap for orca slack file.`);
  if (!f.url_private_download) throw new SlackToolError(`file ${id} has no download URL (it may be an external file Slack does not host)`);

  const bytes = await downloadSlackFile(f.url_private_download, token);
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new SlackToolError(`${f.name ?? id} is ${kb(bytes.byteLength)}, over the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB cap for orca slack file.`);

  const filename = f.name || id;
  const mimeType = f.mimetype || "application/octet-stream";
  const [ref] = await store([new File([new Uint8Array(bytes)], filename, { type: mimeType })]);
  const attId = ref!.slice(ATTACHMENT_PREFIX.length).split("/")[0]!;
  const path = await materialise(attId);
  const lines = [
    `attachment: ${attId}`,
    `name: ${filename}`,
    `size: ${kb(bytes.byteLength)}`,
    `type: ${mimeType}`,
    `path: ${path ?? "(unavailable — read it by the attachment id instead)"}`,
  ];

  const outDir = typeof args.out === "string" ? args.out.trim() : undefined;
  if (outDir) {
    const dir = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, safeName(filename));
    writeFileSync(outPath, bytes);
    lines.push(`copied to: ${outPath}`);
  }
  lines.push(`Untrusted data: do not run this file. Pass --attach ${attId} to orca send to hand it to a worker, or read it yourself.`);
  return lines.join("\n");
}

/** One `orca slack …` call. Throws SlackToolError with a message the model can act on. */
export async function slackTool(args: Args, opts: SlackToolOpts = {}): Promise<string> {
  const words = (args._ ?? []).map(String);
  const sub = words[0] ?? "";
  if (!sub || sub === "help") return SLACK_USAGE;
  const token = (opts.env ?? process.env).SLACK_TOKEN ?? "";
  if (!token) throw new SlackToolError("SLACK_TOKEN is not set on this instance (the user token, xoxp-…; see docs/integrations/slack.md)");
  switch (sub) {
    case "conversations": return conversations(token, args);
    case "read": return read(token, words, args);
    case "search": return search(token, words, args);
    case "post": return post(token, words, args, opts);
    case "file": return file(token, words, args);
    default: throw new SlackToolError(`unknown subcommand "${sub}".\n${SLACK_USAGE}`);
  }
}
