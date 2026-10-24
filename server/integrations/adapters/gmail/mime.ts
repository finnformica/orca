// The Gmail adapter's pure mail half (docs/integrations/gmail.md): parse a raw RFC 5322 message into
// what the core needs (sender, plain text, attachments), and decide whether it may reach Orca at all
// (the DKIM/SPF check and the allow list). No I/O, so the tests drive it directly.

// ── Parse ─────────────────────────────────────────────────────────────────────────────────────────

export type Headers = Map<string, string[]>; // lower-case name → raw (unfolded) values, in message order

export type ParsedAttachment = { filename: string; mimeType: string; bytes: Uint8Array };

export type ParsedMail = {
  headers: Headers;
  from?: { address: string; name?: string };
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  date?: number;
  text: string; // plain text: text/plain, else text/html reduced to text
  attachments: ParsedAttachment[];
};

const CRLF2 = /\r?\n\r?\n/;

/** Split at the first blank line. Header bytes are ASCII (8-bit tolerated as latin1). */
function split(raw: Uint8Array): { head: string; body: Uint8Array } {
  const s = Buffer.from(raw).toString("latin1");
  const m = CRLF2.exec(s);
  if (!m) return { head: s, body: new Uint8Array() };
  return { head: s.slice(0, m.index), body: raw.subarray(m.index + m[0].length) };
}

export function parseHeaders(head: string): Headers {
  const out: Headers = new Map();
  const lines = head.split(/\r?\n/);
  let cur: string | undefined;
  const push = () => {
    if (!cur) return;
    const i = cur.indexOf(":");
    if (i > 0) {
      const k = cur.slice(0, i).trim().toLowerCase();
      out.set(k, [...(out.get(k) ?? []), cur.slice(i + 1).trim()]);
    }
  };
  for (const l of lines) {
    if (/^[ \t]/.test(l) && cur !== undefined) cur += " " + l.trim();
    else { push(); cur = l; }
  }
  push();
  return out;
}

const first = (h: Headers, k: string): string | undefined => h.get(k)?.[0];

function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  try { return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function qpDecode(s: string, header = false): Uint8Array {
  if (header) s = s.replace(/_/g, " ");
  s = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded words (`=?utf-8?B?…?=`); whitespace between two encoded words is dropped. */
export function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) =>
      decodeBytes(enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : qpDecode(data, true), cs));
}

/** `type/sub; a=b; c="d"` → { value, params }, with RFC 2231 `name*=utf-8''x%20y` decoded. */
export function parseParams(v: string | undefined): { value: string; params: Record<string, string> } {
  const parts = (v ?? "").match(/(?:[^;"]+|"(?:[^"\\]|\\.)*")+/g) ?? [""];
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim().replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1");
    if (k.endsWith("*")) {
      k = k.slice(0, -1).replace(/\*\d+$/, "");
      const m = val.match(/^([^']*)'[^']*'(.*)$/);
      val = decodeBytes(percentBytes(m ? m[2]! : val), m?.[1] || "utf-8");
    } else k = k.replace(/\*\d+$/, "");
    params[k] = (params[k] ?? "") + decodeWords(val);
  }
  return { value: (parts[0] ?? "").trim().toLowerCase(), params };
}

const percentBytes = (s: string): Uint8Array =>
  new Uint8Array([...s.matchAll(/%([0-9a-f]{2})|([\s\S])/gi)].flatMap((m) => (m[1] ? [parseInt(m[1], 16)] : [...Buffer.from(m[2]!, "utf8")])));

function transferDecode(body: Uint8Array, enc: string | undefined): Uint8Array {
  const e = (enc ?? "").trim().toLowerCase();
  if (e === "base64") return Buffer.from(Buffer.from(body).toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return qpDecode(Buffer.from(body).toString("latin1"));
  return body;
}

/** One `Name <a@b>` / `a@b` address. Lower-cased address. */
export function parseAddress(v: string | undefined): { address: string; name?: string } | undefined {
  if (!v) return undefined;
  const s = decodeWords(v);
  const angle = s.match(/^(.*)<([^>]+)>/);
  const address = (angle ? angle[2]! : s.match(/[^\s<>,;"]+@[^\s<>,;"]+/)?.[0] ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return undefined;
  const name = angle?.[1]?.trim().replace(/^"(.*)"$/, "$1").trim();
  return name ? { address, name } : { address };
}

/** `<a@b> <c@d>` → ["<a@b>", "<c@d>"]. Message-IDs keep their angle brackets everywhere in Orca. */
export const msgIds = (v: string | undefined): string[] => v?.match(/<[^<>\s]+>/g) ?? [];

type Part = { headers: Headers; body: Uint8Array };

function walk(part: Part, out: { plain?: string; html?: string; attachments: ParsedAttachment[] }, depth = 0): void {
  const ct = parseParams(first(part.headers, "content-type") ?? "text/plain");
  const disp = parseParams(first(part.headers, "content-disposition"));
  const filename = disp.params.filename ?? ct.params.name;
  if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < 10) {
    const esc = ct.params.boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let b = Buffer.from(part.body).toString("latin1");
    const close = new RegExp(`(?:^|\\r?\\n)--${esc}--`).exec(b);
    if (close) b = b.slice(0, close.index);
    const chunks = b.split(new RegExp(`(?:^|\\r?\\n)--${esc}[ \\t]*(?:\\r?\\n|$)`)).slice(1); // [0] is the preamble
    for (const c of chunks) {
      if (!c.trim()) continue;
      const s = split(Buffer.from(c, "latin1"));
      walk({ headers: parseHeaders(s.head), body: s.body }, out, depth + 1);
    }
    return;
  }
  const bytes = transferDecode(part.body, first(part.headers, "content-transfer-encoding"));
  const isText = ct.value === "text/plain" || ct.value === "text/html";
  if (isText && disp.value !== "attachment" && !filename) {
    const text = decodeBytes(bytes, ct.params.charset);
    if (ct.value === "text/plain") out.plain ??= text;
    else out.html ??= text;
    return;
  }
  out.attachments.push({ filename: filename || (ct.value === "message/rfc822" ? "message.eml" : "attachment"), mimeType: ct.value || "application/octet-stream", bytes });
}

export function parseMail(raw: Uint8Array): ParsedMail {
  const s = split(raw);
  const headers = parseHeaders(s.head);
  const out: { plain?: string; html?: string; attachments: ParsedAttachment[] } = { attachments: [] };
  walk({ headers, body: s.body }, out);
  const date = Date.parse(first(headers, "date") ?? "");
  return {
    headers,
    from: parseAddress(first(headers, "from")),
    subject: decodeWords(first(headers, "subject") ?? "").trim(),
    messageId: msgIds(first(headers, "message-id"))[0],
    inReplyTo: msgIds(first(headers, "in-reply-to"))[0],
    references: msgIds((headers.get("references") ?? []).join(" ")),
    ...(Number.isFinite(date) ? { date } : {}),
    text: (out.plain ?? (out.html ? htmlToText(out.html) : "")).replace(/\r\n/g, "\n").trim(),
    attachments: out.attachments,
  };
}

// ── Plain text ────────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };

/** HTML mail reduced to the text an agent reads: no script/style/head, block tags as line breaks,
 *  list items as "- ", links as "text (url)", entities decoded, blank runs collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
      const t = inner.replace(/<[^>]+>/g, "").trim();
      return !t || t === href || href.startsWith("mailto:") ? t || href : `${t} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|tr|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The new part of a reply: cut at the client's "On … wrote:" line or an "Original Message" rule,
 *  and drop the trailing `>` quote. The full mail stays in Gmail. */
export function stripQuotedReply(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim(), two = `${l} ${lines[i + 1]?.trim() ?? ""}`;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || /^On .{4,200} wrote:$/.test(l)) { end = i; break; }
    if (/^On .{4,200}$/.test(l) && /^On .{4,200} wrote:$/.test(two)) { end = i; break; }
  }
  const kept = lines.slice(0, end);
  while (kept.length && (/^\s*>/.test(kept[kept.length - 1]!) || !kept[kept.length - 1]!.trim())) kept.pop();
  const out = kept.join("\n").trim();
  return out || text.trim(); // a mail that is all quote keeps its text
}

// ── The gate ──────────────────────────────────────────────────────────────────────────────────────

export type AuthResult = { method: string; result: string; props: Record<string, string> };

/** One `Authentication-Results` header (RFC 8601): the authserv-id and each method's result. */
export function parseAuthResults(v: string): { authservId: string; results: AuthResult[] } {
  const s = v.replace(/\([^()]*\)/g, " ");
  const [head, ...rest] = s.split(";");
  const results: AuthResult[] = [];
  for (const r of rest) {
    const toks = r.trim().split(/\s+/).filter(Boolean);
    const m = toks[0]?.match(/^([\w-]+)=([\w-]+)$/);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const t of toks.slice(1)) { const i = t.indexOf("="); if (i > 0) props[t.slice(0, i).toLowerCase()] = t.slice(i + 1).replace(/^"(.*)"$/, "$1"); }
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authservId: (head ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "", results };
}

const domainOf = (v: string | undefined): string => (v ?? "").replace(/^.*@/, "").replace(/[>\s]/g, "").toLowerCase();
/** Relaxed alignment (DMARC): the same domain, or one is a subdomain of the other's. */
const aligned = (a: string, b: string): boolean => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

/** Whether the receiving server vouched for the From domain. Only the `Authentication-Results`
 *  headers of OUR receiving server count (`authservId`; unset = the topmost header, which that server
 *  adds last): a sender can write any header it likes below it. Pass = dmarc=pass for the From domain,
 *  or an aligned dkim=pass, or (unless `requireDkim`) an aligned spf=pass. */
export function authVerdict(headers: Headers, fromAddress: string, opts: { authservId?: string; requireDkim?: boolean } = {}): { ok: boolean; reason: string } {
  const all = (headers.get("authentication-results") ?? []).map(parseAuthResults);
  const want = opts.authservId?.toLowerCase();
  const trusted = want ? all.filter((a) => a.authservId === want) : all.slice(0, 1);
  if (!trusted.length) return { ok: false, reason: want ? `no Authentication-Results from ${want}` : "no Authentication-Results header" };
  const from = domainOf(fromAddress);
  for (const { results } of trusted) {
    for (const r of results) {
      if (r.result !== "pass") continue;
      if (r.method === "dmarc" && !opts.requireDkim && aligned(domainOf(r.props["header.from"] ?? from), from)) return { ok: true, reason: "dmarc=pass" };
      if (r.method === "dkim" && aligned(domainOf(r.props["header.d"] ?? r.props["header.i"]), from)) return { ok: true, reason: `dkim=pass (${domainOf(r.props["header.d"] ?? r.props["header.i"])})` };
      if (r.method === "spf" && !opts.requireDkim && aligned(domainOf(r.props["smtp.mailfrom"]), from)) return { ok: true, reason: `spf=pass (${domainOf(r.props["smtp.mailfrom"])})` };
    }
  }
  const seen = trusted.flatMap((t) => t.results.map((r) => `${r.method}=${r.result}`)).join(" ") || "no results";
  return { ok: false, reason: `no aligned pass for ${from} (${seen})` };
}

/** The allow list: exact addresses, or `@domain` for a whole domain. Empty = nobody. */
export function senderAllowed(address: string, allowed: readonly string[]): boolean {
  const a = address.toLowerCase();
  return allowed.some((x) => {
    const v = x.trim().toLowerCase();
    return v.startsWith("@") ? a.endsWith(v) : v === a;
  });
}

/** An auto-reply, a bounce or a list mail: never answered, or two robots mail each other forever. */
export function isAutomated(h: Headers): boolean {
  const auto = first(h, "auto-submitted")?.toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(first(h, "precedence") ?? "")) return true;
  if (h.has("list-id") || h.has("x-autoreply") || h.has("x-autorespond")) return true;
  return /^(mailer-daemon|postmaster)@/i.test(parseAddress(first(h, "from"))?.address ?? "");
}

/** The text an agent reads for one mail: the subject, the new part of the body, and a note per
 *  attachment that could not be kept. */
export function inboundText(m: ParsedMail, opts: { keepQuoted?: boolean; skipped?: string[] } = {}): string {
  const body = opts.keepQuoted ? m.text : stripQuotedReply(m.text);
  return [
    m.subject ? `Subject: ${m.subject}` : "",
    body,
    ...(opts.skipped ?? []).map((s) => `[attachment not kept: ${s}]`),
  ].filter(Boolean).join("\n\n");
}
