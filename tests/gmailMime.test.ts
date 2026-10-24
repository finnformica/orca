// The Gmail adapter's pure mail parse (server/integrations/adapters/gmail/mime.ts): MIME, plain
// text, the quoted reply, the DKIM/SPF/DMARC check and the sender allow list. No I/O.
import { describe, expect, test } from "bun:test";
import { authVerdict, htmlToText, inboundText, isAutomated, parseHeaders, parseMail, senderAllowed, stripQuotedReply } from "../server/integrations/adapters/gmail/mime";

const PASS = "mx.example.com; dkim=pass header.d=example.com header.s=s1; spf=pass smtp.mailfrom=finn@example.com; dmarc=pass header.from=example.com";

/** One raw mail, CRLF. */
function mail(o: { from?: string; auth?: string[]; subject?: string; text?: string; html?: string; id: string; inReplyTo?: string; references?: string; attach?: { name: string; bytes: Buffer }; extra?: string[] }): string {
  const head = [
    ...(o.auth ?? [PASS]).map((a) => `Authentication-Results: ${a}`),
    `From: ${o.from ?? "Finn <finn@example.com>"}`,
    "To: orca@example.com",
    `Subject: ${o.subject ?? "Hello"}`,
    "Date: Sat, 17 Oct 2026 10:00:00 +0000",
    `Message-ID: ${o.id}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    ...(o.extra ?? []),
    "MIME-Version: 1.0",
  ];
  const body = o.html
    ? ["Content-Type: text/html; charset=utf-8", "", o.html]
    : ["Content-Type: text/plain; charset=utf-8", "", o.text ?? "Hi Orca"];
  if (!o.attach) return [...head, ...body].join("\r\n");
  return [
    ...head, 'Content-Type: multipart/mixed; boundary="b1"', "", "preamble", "--b1", ...body,
    "--b1", `Content-Type: application/octet-stream; name="${o.attach.name}"`, `Content-Disposition: attachment; filename="${o.attach.name}"`,
    "Content-Transfer-Encoding: base64", "", o.attach.bytes.toString("base64"), "--b1--", "",
  ].join("\r\n");
}

describe("mime (pure)", () => {
  test("parse: encoded subject, From name, Message-IDs, quoted-printable text and a base64 attachment", () => {
    const raw = [
      "From: =?UTF-8?B?RmlubiDinIU=?= <Finn@Example.com>",
      "Subject: =?utf-8?q?Caf=C3=A9_plan?=",
      "Message-ID: <m2@example.com>", "In-Reply-To: <m1@example.com>",
      "References: <root@orca.test>\r\n <m1@example.com>",
      'Content-Type: multipart/mixed; boundary="xx"', "",
      "--xx", 'Content-Type: multipart/alternative; boundary="yy"', "",
      "--yy", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
      "Ship it =E2=80=94 soon.=", "", "--yy", "Content-Type: text/html", "", "<p>Ship it</p>", "--yy--",
      "--xx", "Content-Type: text/plain; name=\"log.txt\"", "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.txt", "Content-Transfer-Encoding: base64", "",
      Buffer.from("log line").toString("base64"), "--xx--", "",
    ].join("\r\n");
    const m = parseMail(Buffer.from(raw));
    expect(m.from).toEqual({ address: "finn@example.com", name: "Finn ✅" });
    expect(m.subject).toBe("Café plan");
    expect(m.messageId).toBe("<m2@example.com>");
    expect(m.references).toEqual(["<root@orca.test>", "<m1@example.com>"]);
    expect(m.text).toBe("Ship it — soon.");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.filename).toBe("résumé.txt");
    expect(Buffer.from(m.attachments[0]!.bytes).toString()).toBe("log line");
  });

  test("parse: a multipart with no closing boundary keeps its last part", () => {
    const raw = 'Content-Type: multipart/mixed; boundary="q"\r\n\r\n--q\r\nContent-Type: text/plain\r\n\r\nonly part\r\n';
    expect(parseMail(Buffer.from(raw)).text).toBe("only part");
  });

  test("HTML mail becomes plain text: no style/script, blocks as lines, lists, links, entities", () => {
    const html = `<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Orca,</p><div>Please fix <a href="https://x.test/pr/7">PR 7</a> &amp; ship.</div><ul><li>one</li><li>two</li></ul><script>alert(1)</script>Thanks<br>Finn &#8212; &#x1F600;</body></html>`;
    expect(htmlToText(html)).toBe("Hi Orca,\n\nPlease fix PR 7 (https://x.test/pr/7) & ship.\n\n- one\n- two\nThanks\nFinn — 😀");
    const m = parseMail(Buffer.from(mail({ id: "<h@x>", html })));
    expect(m.text).toContain("Please fix PR 7 (https://x.test/pr/7) & ship.");
  });

  test("a reply keeps only its new part", () => {
    expect(stripQuotedReply("Yes, merge it.\n\nOn Sat, 17 Oct 2026 at 10:00, Orca <orca@example.com> wrote:\n> CI is green.")).toBe("Yes, merge it.");
    expect(stripQuotedReply("Go.\n\nOn Sat, 17 Oct 2026 at 10:00, Orca\n<orca@example.com> wrote:\n> x")).toBe("Go.");
    expect(stripQuotedReply("Ok\n-----Original Message-----\nFrom: x")).toBe("Ok");
    expect(stripQuotedReply("> only a quote")).toBe("> only a quote");
  });

  test("the auth gate trusts only OUR server's Authentication-Results, and needs alignment with From", () => {
    const h = (...ar: string[]) => parseHeaders(ar.map((a) => `Authentication-Results: ${a}`).join("\r\n"));
    expect(authVerdict(h(PASS), "finn@example.com", { authservId: "mx.example.com" })).toMatchObject({ ok: true, reason: "dkim=pass (example.com)" });
    expect(authVerdict(h("mx.example.com; dmarc=pass header.from=example.com"), "finn@example.com")).toMatchObject({ ok: true, reason: "dmarc=pass" });
    // A sender wrote a passing header of its own BELOW the real one: ignored.
    const forged = h("mx.example.com; dkim=fail header.d=example.com; spf=softfail smtp.mailfrom=evil.test", "mx.example.com.evil; dkim=pass header.d=example.com");
    expect(authVerdict(forged, "finn@example.com", { authservId: "mx.example.com" }).ok).toBe(false);
    expect(authVerdict(forged, "finn@example.com").ok).toBe(false); // unset: only the topmost header counts
    // A valid DKIM pass for ANOTHER domain proves nothing about From.
    expect(authVerdict(h("mx.example.com; dkim=pass header.d=evil.test"), "finn@example.com").ok).toBe(false);
    // Relaxed alignment: a subdomain signature counts.
    expect(authVerdict(h("mx.example.com; dkim=pass (good) header.i=@mail.example.com"), "finn@example.com").ok).toBe(true);
    // SPF alone passes, unless DKIM is required.
    const spf = h("mx.example.com; spf=pass smtp.mailfrom=bounce@example.com");
    expect(authVerdict(spf, "finn@example.com").ok).toBe(true);
    expect(authVerdict(spf, "finn@example.com", { requireDkim: true }).ok).toBe(false);
    expect(authVerdict(parseHeaders("From: a@b"), "a@b")).toMatchObject({ ok: false, reason: "no Authentication-Results header" });
  });

  test("the allow list, automated mail and the inbound text", () => {
    const allowed = ["finn@example.com", "@team.test"];
    expect(senderAllowed("Ann@Team.test", allowed)).toBe(true);
    expect(senderAllowed("ann@notteam.test", allowed)).toBe(false);
    expect(senderAllowed("x@y", [])).toBe(false);
    expect(isAutomated(parseHeaders("From: MAILER-DAEMON@mx.test"))).toBe(true);
    expect(isAutomated(parseHeaders("Auto-Submitted: no"))).toBe(false);
    expect(isAutomated(parseMail(Buffer.from(mail({ id: "<3@x>", extra: ["Auto-Submitted: auto-replied"] }))).headers)).toBe(true);
    const m = parseMail(Buffer.from(mail({ id: "<i@x>", subject: "Plan", text: "Do it.\n\nOn Fri, Orca wrote:\n> old" })));
    expect(inboundText(m, { skipped: ["big.zip is over 20 MB"] })).toBe("Subject: Plan\n\nDo it.\n\n[attachment not kept: big.zip is over 20 MB]");
  });
});
