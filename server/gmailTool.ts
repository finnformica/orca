// `orca gmail …`: the orchestrator reads the user's Gmail (docs/integrations/gmail.md). The bridge
// calls the Gmail API with the connected integration's access token (./integrations/adapters/gmail/
// oauth.ts: the refresh token is a stored secret, the access token stays in memory), never printed.
// Read only: a reply goes through the adapter (`orca post --reply`, or `orca post --link <id>`), so
// it is queued, retried and recorded like every other post. The grant check (shared/integrations.ts
// grantRefusal: an unknown verb is the owner's) keeps `orca gmail` to the user's own chat.
//
//   orca gmail search "<gmail query>" [--limit 10] [--integration <id>]
//   orca gmail read <message id> [--integration <id>]
import { clip } from "../shared/integrations";
import { parseMail } from "./integrations/adapters/email/mime";
import { fromBase64Url, header, type Gmail } from "./integrations/adapters/gmail/google";
import * as oauth from "./integrations/adapters/gmail/oauth";
import * as store from "./integrations/store";
import type { Connection } from "./integrations/adapter";

type Args = Record<string, unknown> & { _?: unknown[] };

export const GMAIL_USAGE = [
  "orca gmail search \"<gmail query>\" [--limit 10] [--integration <id>]   find messages (Gmail search syntax: from:ana newer_than:7d)",
  "orca gmail read <message id> [--integration <id>]   one message: headers, text and attachment names",
  "Read only. Answer a mail that woke you with `orca post --reply`.",
].join("\n");

export const SEARCH_MAX = 50;
export const READ_TEXT_MAX = 20_000;

export class GmailToolError extends Error {}

/** The Gmail integration to read: `--integration`, else the only enabled one. */
export async function gmailIntegration(want?: string): Promise<Connection> {
  const rows = (await store.integrations()).filter((c) => c.kind === "gmail" && c.enabled);
  if (want) {
    const c = rows.find((r) => r.id === want);
    if (!c) throw new GmailToolError(`no enabled Gmail integration "${want}" (enabled: ${rows.map((r) => r.id).join(", ") || "none"})`);
    return c;
  }
  if (!rows.length) throw new GmailToolError("no Gmail integration is connected: the user connects one in Integrations > Connect > Gmail (docs/integrations/gmail.md)");
  if (rows.length > 1) throw new GmailToolError(`more than one Gmail integration: name one with --integration (${rows.map((r) => r.id).join(", ")})`);
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
  if (sub !== "search" && sub !== "read") throw new GmailToolError(`unknown subcommand "${sub}" (Gmail is read only here; a reply is orca post --reply).\n${GMAIL_USAGE}`);
  const c = await gmailIntegration(typeof args.integration === "string" ? args.integration : undefined);
  const g = oauth.gmailFor(c);
  return sub === "search" ? search(g, words, args) : read(g, words);
}
