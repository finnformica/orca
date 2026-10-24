// An integration's secret from an environment variable or from Orca's secret store (`secret:<name>`):
// the ref rules (shared/integrations.ts), the refs a row names and where a value comes from
// (server/integrations/secretRefs.ts), and which bridge may take an Automatic row (registry.secretHere).
// The end-to-end case — a real registry, an email adapter on stored IMAP and SMTP passwords, a
// rotation and a delete — is in tests/email.test.ts.
import { afterEach, expect, test } from "bun:test";
import { ORCA_SECRETS } from "../server/env";
import { secretHere } from "../server/integrations/registry";
import { clear, refsOf, secretValue, storedNames } from "../server/integrations/secretRefs";
import { secretRefRefusal, storedSecretName } from "../shared/integrations";

afterEach(() => clear());

test("secret_ref: a stripped variable or secret:<name> / secret:<scope>/<name>; never a plain value", () => {
  for (const ok of ["ORCA_SECRET_X", "SLACK_TOKEN", "secret:gmail-app", "secret:mail/gmail_app.v2"]) expect(secretRefRefusal(ok, ORCA_SECRETS)).toBeUndefined();
  expect(secretRefRefusal("secret:", ORCA_SECRETS)).toContain("must name a stored secret");
  expect(secretRefRefusal("secret:has space", ORCA_SECRETS)).toContain("must name a stored secret");
  expect(secretRefRefusal("secret:a/b/c", ORCA_SECRETS)).toContain("must name a stored secret");
  expect(secretRefRefusal("HOME", ORCA_SECRETS)).toContain("or be secret:<stored name>");
  expect(secretRefRefusal("xoxp-1234-abcd", ORCA_SECRETS)).toContain("must be an environment variable name");
  expect(storedSecretName("secret:mail/gmail")).toBe("mail/gmail");
  expect(storedSecretName("ORCA_SECRET_X")).toBeUndefined();
});

test("refsOf: the secret_ref, then every config …Ref, nested too; storedNames keeps the secret: ones", () => {
  const c = { secretRef: "secret:gmail-app", config: { address: "o@x.test", smtpSecretRef: "secret:gmail-smtp", resend: { secretRef: "ORCA_SECRET_RESEND" }, appTokenRef: "SLACK_APP_TOKEN", note: "secret:not-a-ref" } };
  expect(refsOf(c)).toEqual(["secret:gmail-app", "secret:gmail-smtp", "ORCA_SECRET_RESEND", "SLACK_APP_TOKEN"]);
  expect(storedNames(c)).toEqual(["gmail-app", "gmail-smtp"]);
  expect(refsOf({ config: {} })).toEqual([]);
});

test("secretValue: a variable from the environment; a stored secret only once the registry loaded it, never a variable of that name", () => {
  expect(secretValue("ORCA_SECRET_X", { ORCA_SECRET_X: "v" })).toBe("v");
  expect(secretValue("ORCA_SECRET_X", {})).toBeUndefined();
  expect(secretValue("secret:gmail-app", { "secret:gmail-app": "nope", "gmail-app": "nope" })).toBeUndefined();
  expect(secretValue(undefined)).toBeUndefined();
});

test("secretHere: an Automatic row goes only to a bridge with the variable and the key for each stored secret", () => {
  const stored = { secretRef: "secret:gmail-app", config: { smtpSecretRef: "secret:gmail-smtp" } };
  expect(secretHere(stored, {}, new Set(["gmail-app", "gmail-smtp"]))).toBe(true);
  expect(secretHere(stored, {}, new Set(["gmail-app"]))).toBe(false); // another key stored gmail-smtp
  expect(secretHere(stored, {}, new Set())).toBe(false);
  expect(secretHere({ secretRef: "ORCA_SECRET_X", config: {} }, { ORCA_SECRET_X: "v" })).toBe(true);
  expect(secretHere({ secretRef: "ORCA_SECRET_X", config: {} }, {})).toBe(false);
  expect(secretHere({ config: {} }, {})).toBe(true);
});
