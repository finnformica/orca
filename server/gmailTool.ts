// `orca gmail …`: the orchestrator reads the user's Gmail (docs/integrations/gmail.md). Each connected
// account is its own integration row; `--account <id or name>` picks one, and may be left out when
// only one is connected (the access policy's pickAccount rule). The bridge calls the Gmail API with
// that row's access token (./integrations/adapters/gmail/oauth.ts: the refresh token is a stored
// secret, the access token stays in memory), never printed. Both verbs are READS (GMAIL_VERBS); Gmail
// has no write verb. The grant check (shared/integrations.ts grantRefusal: an unknown verb is the
// owner's) keeps `orca gmail` to the user's own chat.
//
//   orca gmail search "<gmail query>" [--limit 10] [--account <name>]
//   orca gmail read <message id> [--account <name>]
import { clip } from "../shared/integrations";
import { parseMail } from "./integrations/adapters/email/mime";
import { fromBase64Url, header, type Gmail } from "./integrations/adapters/gmail/google";
import * as oauth from "./integrations/adapters/gmail/oauth";
import * as store from "./integrations/store";
import type { Connection } from "./integrations/adapter";

type Args = Record<string, unknown> & { _?: unknown[] };

export const GMAIL_USAGE = [
  "orca gmail search \"<gmail query>\" [--limit 10] [--account <name>]   find messages (Gmail search syntax: from:ana newer_than:7d)",
  "orca gmail read <message id> [--account <name>]   one message: headers, text and attachment names",
  "Read only: Orca sends no mail and marks nothing read. --account names the account (its id or name); leave it out when only one is connected.",
].join("\n");

export const SEARCH_MAX = 50;
export const READ_TEXT_MAX = 20_000;

export class GmailToolError extends Error {}

/** The Gmail account to read: `--account <id or name>` (case-insensitive), else the only enabled one.
 *  Several and no name is an error, never a guess. */
export async function gmailAccount(want?: string): Promise<Connection> {
  const rows = (await store.integrations()).filter((c) => c.kind === "gmail" && c.enabled);
  const list = rows.map((r) => (r.name && r.name !== r.id ? `${r.id} (${r.name})` : r.id)).join(", ");
  const name = want?.trim().toLowerCase();
  if (name) {
    const c = rows.find((r) => r.id.toLowerCase() === name) ?? rows.find((r) => r.name.toLowerCase() === name);
    if (!c) throw new GmailToolError(`no Gmail account "${want}" (accounts: ${list || "none"})`);
    return c;
  }
  if (!rows.length) throw new GmailToolError("no Gmail account is connected: the user connects one in Integrations > Connect > Gmail (docs/integrations/gmail.md)");
  if (rows.length > 1) throw new GmailToolError(`${rows.length} Gmail accounts are connected (${list}): name one with --account <name>`);
  return rows[0]!;
}

const dateOf = (internalDate?: string): string => {
  const n = Number(internalDate);
  return n ? new Date(n).toISOString().slice(0, 16).replace("T", " ") : "?";
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
    ...(m.attachments.length ? [`Attachments: ${m.attachments.map((a) => `${a.filename} (${Math.ceil(a.bytes.byteLength / 1024)} KB)`).join(", ")}`] : []),
    "",
    m.text.length > READ_TEXT_MAX ? `${m.text.slice(0, READ_TEXT_MAX)}\n…(cut at ${READ_TEXT_MAX} characters)` : m.text,
  ].join("\n");
}

export async function gmailTool(args: Args): Promise<string> {
  const words = (args._ ?? []).map(String);
  const sub = words[0] ?? "";
  if (!sub || sub === "help") return GMAIL_USAGE;
  if (sub !== "search" && sub !== "read") throw new GmailToolError(`unknown subcommand "${sub}" (Gmail is read only: there is no write verb).\n${GMAIL_USAGE}`);
  if (args.account !== undefined && (typeof args.account !== "string" || !args.account.trim())) throw new GmailToolError("--account needs an account id or name (orca channels lists them)");
  const c = await gmailAccount(typeof args.account === "string" ? args.account : undefined);
  const g = oauth.gmailFor(c);
  const out = sub === "search" ? await search(g, words, args) : await read(g, words);
  return `Gmail account ${c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id}\n${out}`;
}
