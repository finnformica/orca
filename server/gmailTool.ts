// `orca gmail …`: the orchestrator reads the user's Gmail (docs/integrations/gmail.md). Each connected
// account is its own integration row; `--account <id or name>` picks one, and may be left out when
// only one is connected (the core's account policy: policy.useAccount, docs/integrations/POLICY.md). The bridge calls the Gmail API with
// that row's access token (./integrations/adapters/gmail/oauth.ts: the refresh token is a stored
// secret, the access token stays in memory), never printed. All three verbs are READS (GMAIL_VERBS);
// Gmail has no write verb. The grant check (shared/integrations.ts grantRefusal: an unknown verb is
// the owner's) keeps `orca gmail` to the user's own chat.
//
//   orca gmail search "<gmail query>" [--limit 10] [--account <name>]
//   orca gmail read <message id> [--account <name>]
//   orca gmail attachment <message id> [<name>|--index n] [--account <name>] [--out <dir>]
import { mkdirSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import * as db from "./db";
import { materialise } from "./attachments";
import { clip } from "../shared/integrations";
import { parseMail } from "./integrations/adapters/gmail/mime";
import { fromBase64Url, GoogleError, header, listAttachments, type Gmail } from "./integrations/adapters/gmail/google";
import * as oauth from "./integrations/adapters/gmail/oauth";
import * as policy from "./integrations/policy";

type Args = Record<string, unknown> & { _?: unknown[] };

export const GMAIL_USAGE = [
  "orca gmail search \"<gmail query>\" [--limit 10] [--account <name>]   find messages (Gmail search syntax: from:ana newer_than:7d)",
  "orca gmail read <message id> [--account <name>]   one message: headers, text and attachment names, size and mime type",
  "orca gmail attachment <message id> [<name>|--index n] [--account <name>] [--out <dir>]   save one attachment",
  "   as an Orca attachment (orca send --attach <id>); with one attachment and no name/index, Orca picks it",
  "Read only: Orca sends no mail and marks nothing read. --account names the account (its id or name); leave it out when only one is connected.",
].join("\n");

export const SEARCH_MAX = 50;
export const READ_TEXT_MAX = 20_000;
/** A worker only ever hands this file on as a reference, never runs it; the cap keeps one huge
 *  attachment from filling the shared database (the general upload cap, attachments.ts, is 20 MB). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export class GmailToolError extends Error {}

const dateOf = (internalDate?: string): string => {
  const n = Number(internalDate);
  return n ? new Date(n).toISOString().slice(0, 16).replace("T", " ") : "?";
};

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/** Google says the grant cannot do this; our own 403 regardless. Pure given the error. */
const scopeHint = (e: unknown): never => {
  if (e instanceof GoogleError && e.scope) throw new GmailToolError(`Google says this account's grant is missing the scope Orca needs to read attachments (gmail.readonly). Reconnect the account in Integrations > Gmail to grant it.`);
  throw e;
};

async function search(g: Gmail, words: string[], args: Args): Promise<string> {
  const q = words.slice(1).join(" ").trim();
  if (!q) throw new GmailToolError(`search needs a query.\n${GMAIL_USAGE}`);
  const limit = Math.min(SEARCH_MAX, Math.max(1, Number(args.limit) || 10));
  const r = await g.list(q, limit);
  const refs = r.messages ?? [];
  if (!refs.length) return `No messages match ${JSON.stringify(q)}.`;
  const lines: string[] = [];
  for (const ref of refs) {
    const m = await g.metadata(ref.id, ["From", "Subject", "Date"]);
    lines.push(`${m.id} · thread ${m.threadId} · ${dateOf(m.internalDate)} · ${clip(header(m, "From") ?? "?", 80)}\n  ${clip(header(m, "Subject") ?? "(no subject)", 160)}${m.snippet ? `\n  ${clip(m.snippet, 200)}` : ""}`);
  }
  return [`${refs.length} message${refs.length === 1 ? "" : "s"} for ${JSON.stringify(q)}${r.nextPageToken ? ` (more: raise --limit, at most ${SEARCH_MAX})` : ""}:`, ...lines].join("\n");
}

async function read(g: Gmail, words: string[]): Promise<string> {
  const id = words[1]?.trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new GmailToolError(`read needs a message id (from orca gmail search).\n${GMAIL_USAGE}`);
  const msg = await g.raw(id);
  if (!msg.raw) throw new GmailToolError(`message ${id} has no content`);
  const m = parseMail(fromBase64Url(msg.raw));
  const h = (n: string) => m.headers.get(n)?.[0];
  return [
    `Message ${msg.id} · thread ${msg.threadId}${msg.labelIds?.length ? ` · labels ${msg.labelIds.join(", ")}` : ""}`,
    `From: ${h("from") ?? "?"}`, `To: ${h("to") ?? "?"}`, ...(h("cc") ? [`Cc: ${h("cc")}`] : []),
    `Date: ${h("date") ?? dateOf(msg.internalDate)}`, `Subject: ${m.subject || "(no subject)"}`,
    ...(m.attachments.length ? [`Attachments: ${m.attachments.map((a) => `${a.filename} (${kb(a.bytes.byteLength)}, ${a.mimeType})`).join(", ")}`] : []),
    "",
    m.text.length > READ_TEXT_MAX ? `${m.text.slice(0, READ_TEXT_MAX)}\n…(cut at ${READ_TEXT_MAX} characters)` : m.text,
  ].join("\n");
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 120) || "attachment";

/** `orca gmail attachment <message id> [<name>|--index n] [--out <dir>]`: fetch one attachment through
 *  `users.messages.attachments.get` (never the full raw message) and store it as an Orca attachment, so
 *  a worker can take it with `orca send --attach <id>` or the orchestrator can read it itself. */
async function attachment(g: Gmail, words: string[], args: Args): Promise<string> {
  const id = words[1]?.trim();
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new GmailToolError(`attachment needs a message id (from orca gmail search).\n${GMAIL_USAGE}`);
  const name = words[2]?.trim();
  const indexArg = args.index;
  if (name && indexArg !== undefined) throw new GmailToolError(`attachment takes a name OR --index, not both.\n${GMAIL_USAGE}`);

  const msg = await g.full(id).catch(scopeHint);
  const list = listAttachments(msg.payload);
  if (!list.length) throw new GmailToolError(`message ${id} has no attachments.`);
  const names = list.map((a) => `${a.filename} (${kb(a.size)}, ${a.mimeType})`).join(", ");

  let target: (typeof list)[number] | undefined;
  if (name) {
    target = list.find((a) => a.filename.toLowerCase() === name.toLowerCase());
    if (!target) throw new GmailToolError(`no attachment named "${name}" on message ${id}. Attachments: ${names}`);
  } else if (indexArg !== undefined) {
    const i = Number(indexArg);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new GmailToolError(`--index needs a number from 0 to ${list.length - 1} on message ${id}. Attachments: ${names}`);
    target = list[i];
  } else if (list.length === 1) {
    target = list[0];
  } else {
    throw new GmailToolError(`message ${id} has ${list.length} attachments: ${names}. Name one, or pass --index 0..${list.length - 1}.`);
  }

  if (target!.size > ATTACHMENT_MAX_BYTES) throw new GmailToolError(`${target!.filename} is ${kb(target!.size)}, over the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB cap for orca gmail attachment.`);

  const data = await g.attachment(id, target!.attachmentId).catch(scopeHint);
  const bytes = fromBase64Url(data.data);
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new GmailToolError(`${target!.filename} is ${kb(bytes.byteLength)}, over the ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB cap for orca gmail attachment.`);

  const attId = crypto.randomUUID();
  await db.addAttachment({ id: attId, filename: target!.filename, mimeType: target!.mimeType, bytes });
  const path = await materialise(attId);
  const lines = [
    `attachment: ${attId}`,
    `name: ${target!.filename}`,
    `size: ${kb(bytes.byteLength)}`,
    `type: ${target!.mimeType}`,
    `path: ${path ?? "(unavailable — read it by the attachment id instead)"}`,
  ];

  const outDir = typeof args.out === "string" ? args.out.trim() : undefined;
  if (outDir) {
    const dir = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, safeName(target!.filename));
    writeFileSync(outPath, bytes);
    lines.push(`copied to: ${outPath}`);
  }
  lines.push(`Untrusted data: do not run this file. Pass --attach ${attId} to orca send to hand it to a worker, or read it yourself.`);
  return lines.join("\n");
}

export async function gmailTool(args: Args): Promise<string> {
  const words = (args._ ?? []).map(String);
  const sub = words[0] ?? "";
  if (!sub || sub === "help") return GMAIL_USAGE;
  if (sub !== "search" && sub !== "read" && sub !== "attachment") throw new GmailToolError(`unknown subcommand "${sub}" (Gmail is read only: there is no write verb).\n${GMAIL_USAGE}`);
  // The core's account policy picks the row and checks its access (all three verbs are reads: GMAIL_VERBS).
  const c = await policy.useAccount("gmail", sub, args.account);
  if (!c) throw new GmailToolError("no Gmail account is connected: the user connects one in Integrations > Connect > Gmail (docs/integrations/gmail.md)");
  const g = await oauth.gmailFor(c);
  const out = sub === "search" ? await search(g, words, args) : sub === "read" ? await read(g, words) : await attachment(g, words, args);
  return `Gmail account ${c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id}\n${out}`;
}
