// Forms in the chat (`orca ask-form`, shared/forms.ts) and the paste guard and scrub
// (shared/secretGuard.ts): the pure rules. The flows against Postgres are in tests/secrets.test.ts.
import { describe, expect, test } from "bun:test";
import {
  FIELD_TYPES, answerErrors, firstRunPerForm, formAnswerMessage, formChannelText, formRefs, parseFormSpec, splitAnswers, turnForms, type FormSpec,
} from "../shared/forms";
import { EVERY_TYPE } from "./formFixture";
import { entropy, looksRandom, replaceFindings, scrubDeep, scrubSecrets, secretFindings } from "../shared/secretGuard";


describe("ask-form spec", () => {
  test("a spec with every field type parses, normalised (options as {value,label})", () => {
    const spec = parseFormSpec({ title: "Set up billing", intro: "Two minutes.", fields: EVERY_TYPE });
    expect(spec.fields.map((f) => f.type)).toEqual([...FIELD_TYPES]);
    expect(spec.fields.find((f) => f.name === "region")!.options).toEqual([{ value: "eu-west-2", label: "eu-west-2" }, { value: "us-east-1", label: "US East" }]);
    expect(spec.fields.find((f) => f.name === "api_key")).toMatchObject({ scope: "billing", required: true });
    // `{ fields: [...] }` is accepted too (a file that wraps the array).
    expect(parseFormSpec({ title: "t", fields: { fields: EVERY_TYPE.slice(0, 1) } }).fields).toHaveLength(1);
  });

  test("every problem is listed in one message, for the model to fix", () => {
    const bad = () => parseFormSpec({
      title: "",
      fields: [
        { name: "1bad", label: "x", type: "text" },
        { name: "a", label: "A", type: "text", colour: "red" },
        { name: "a", label: "Again", type: "text" },
        { name: "b", label: "B", type: "select" },
        { name: "c", label: "C", type: "text", options: ["x"] },
        { name: "d", label: "D", type: "secret", default: "hunter2" },
        { name: "e", label: "E", type: "number", scope: "x" },
        { name: "f", label: "F", type: "number", min: 5, max: 1 },
        { name: "g", label: "G", type: "date", min: "yesterday" },
        { name: "h", label: "H", type: "email", default: "not-an-email" },
        { name: "i", label: "", type: "colour" },
        { name: "j", label: "J", type: "checkbox", min: 1 },
      ],
    });
    expect(bad).toThrow("invalid form");
    const message = (() => { try { bad(); return ""; } catch (e) { return (e as Error).message; } })();
    for (const part of [
      "--title is required", 'field 1: "name" must start', 'field "a": unknown key "colour"', 'field "a": the name is used twice',
      'a select needs "options"', 'only select and multiselect take "options"', 'a secret field takes no "default"', 'only a secret field takes "scope"',
      '"min" is greater than "max"', '"min" must be a YYYY-MM-DD date', '"default" is not valid: must be an email address', '"type" must be one of',
      'a checkbox field takes no "min"',
    ]) expect(message).toContain(part);
  });

  test("no fields, and too many fields, are refused", () => {
    expect(() => parseFormSpec({ title: "t", fields: [] })).toThrow("non-empty JSON array");
    expect(() => parseFormSpec({ title: "t", fields: "nope" })).toThrow("non-empty JSON array");
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `f${i}`, label: `F${i}`, type: "text" }));
    expect(() => parseFormSpec({ title: "t", fields: many })).toThrow("at most 30 fields");
  });
});

describe("answers", () => {
  const spec = parseFormSpec({ title: "Set up billing", fields: EVERY_TYPE }) as FormSpec;
  const good = {
    project: "orca", notes: "", replicas: "3", launch: "2026-11-02", window: "2026-11-02T22:00", region: "us-east-1",
    features: ["auth", "search"], agree: true, homepage: "https://example.com", contact: "a@example.com", api_key: "sk-test-not-a-real-key-000000",
  };

  test("valid answers have no errors; each type checks its own value", () => {
    expect(answerErrors(spec, good)).toEqual({});
    const errs = answerErrors(spec, {
      ...good, project: "", replicas: "11", launch: "2025-12-31", window: "tomorrow", region: "mars", features: [], agree: false,
      homepage: "ftp://x", contact: "nope", api_key: "",
    });
    expect(errs).toEqual({
      project: "is required", replicas: "must be 10 or less", launch: "must be 2026-01-01 or later", window: "must be a date (YYYY-MM-DDTHH:MM)",
      region: "must be one of the options", features: "choose at least 1", agree: "is required", homepage: "must be an http(s) URL",
      contact: "must be an email address", api_key: "is required",
    });
  });

  test("the agent's answers: JSON values, a number as a number, a secret as {name, stored: true} — never its value", () => {
    const { answers, secrets } = splitAnswers(spec, good);
    expect(answers).toMatchObject({ project: "orca", notes: null, replicas: 3, features: ["auth", "search"], agree: true, api_key: { name: "billing/api_key", stored: true } });
    expect(secrets).toEqual([{ field: "api_key", scope: "billing", name: "api_key", value: good.api_key }]);
    const wake = formAnswerMessage({ id: "f-1", title: "Set up billing" }, answers);
    expect(wake).toStartWith("[form answered] Set up billing (form f-1)\n```json\n");
    expect(wake).toContain('"stored": true');
    expect(wake).toContain("orca secret pipe <name>");
    expect(wake).not.toContain(good.api_key);
    // A secret in the default scope is named by its field alone.
    const plain = parseFormSpec({ title: "t", fields: [{ name: "token", label: "Token", type: "secret" }] });
    expect(splitAnswers(plain, { token: "abcdefgh" }).answers.token).toEqual({ name: "token", stored: true });
    expect(splitAnswers(plain, {}).answers.token).toBeNull();
  });

  test("a channel gets the title, the intro and a link — no field", () => {
    const text = formChannelText({ title: "Set up billing", intro: "Two minutes." }, "https://orca.example/orchestrator");
    expect(text).toBe("The orchestrator asks you to fill in a form: Set up billing.\nTwo minutes.\nOpen the Orca chat to answer: https://orca.example/orchestrator");
    expect(text).not.toContain("API key");
  });

  test("a turn finds its form by the orca-form:// line, each form on its first turn", () => {
    const id = "0b9f3c1e-1111-4222-8333-444455556666";
    expect(formRefs(`Asked. orca-form://${id}\nagain orca-form://${id}`)).toEqual([id]);
    expect(turnForms({ forms: [], steps: [{ kind: "result", output: `orca-form://${id}` }, { kind: "result", isError: true, output: "orca-form://ffffffff-0000" }] })).toEqual([id]);
    expect([...firstRunPerForm([{ runId: "r1", output: `orca-form://${id}` }, { runId: "r2", output: `echo orca-form://${id}` }])]).toEqual([["r1", [id]]]);
  });
});

describe("paste guard heuristics", () => {
  test("known key shapes are found, with a suggested name", () => {
    const cases: [string, string][] = [
      ["sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", "anthropic-key"],
      ["sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12", "api-key"],
      [`ghp_${"A1b2C3d4".repeat(5)}`, "github-token"],
      ["github_pat_11ABCDEFG0123456789_abcdefghij", "github-token"],
      ["xoxb-1234567890-abcdefghij", "slack-token"],
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----", "private-key"],
    ];
    for (const [text, name] of cases) {
      const found = secretFindings(`here it is: ${text} thanks`);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ value: text, suggestedName: name });
    }
  });

  test("a long random string is held; a sha, a UUID, a URL and prose are not", () => {
    const random = "Zq8vLm3TxR7kPw2NcY6bHs9JdF4gUa1E";
    expect(entropy(random)).toBeGreaterThan(4);
    expect(looksRandom(random)).toBe(true);
    expect(secretFindings(`token ${random}`)).toMatchObject([{ value: random, kind: "long random string" }]);
    for (const text of [
      "commit 3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c2d4e6f8a0b", "id 123e4567-e89b-12d3-a456-426614174000",
      "see https://github.com/finnformica/orca/pull/419/files#diff-abc", "Please merge #12 when CI is green, thanks a lot!",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "src/components/very/long/path/ChatComposerPasteGuard.tsx",
    ]) expect(secretFindings(text)).toEqual([]);
  });

  test("the broader provider key shapes are each found, with a suggested name", () => {
    // Built at run time, never a literal secret-shaped string, so no scanner mistakes this file
    // for a real credential.
    const cases: [string, string][] = [
      [["sk-or-", "A".repeat(24)].join(""), "openrouter-key"],
      [["sk_live_", "A".repeat(24)].join(""), "stripe-key"],
      [["glpat-", "A".repeat(20)].join(""), "gitlab-token"],
      [["M" + "A".repeat(24), "B".repeat(6), "C".repeat(27)].join("."), "discord-token"],
      [["AIza", "A".repeat(35)].join(""), "google-api-key"],
      [["GOCSPX-", "A".repeat(28)].join(""), "google-oauth-secret"],
      [["SG.", "A".repeat(22), ".", "B".repeat(43)].join(""), "sendgrid-key"],
      [["SK", "0123456789abcdef0123456789abcdef"].join(""), "twilio-key"],
      [["AC", "0123456789abcdef0123456789abcdef"].join(""), "twilio-sid"],
      [["npm_", "A".repeat(36)].join(""), "npm-token"],
      [["pypi-", "A".repeat(50)].join(""), "pypi-token"],
      [["hf_", "A".repeat(34)].join(""), "huggingface-token"],
      [["shpat_", "0123456789abcdef0123456789abcdef"].join(""), "shopify-token"],
      [["secret_", "A".repeat(43)].join(""), "notion-token"],
      [["ntn_", "A".repeat(35)].join(""), "notion-token"],
      [["lin_api_", "A".repeat(40)].join(""), "linear-key"],
      [["eyJ", "A".repeat(20), ".eyJ", "B".repeat(20), ".", "C".repeat(20)].join(""), "jwt"],
    ];
    for (const [text, name] of cases) {
      const found = secretFindings(`here it is: ${text} thanks`);
      expect(found, name).toHaveLength(1);
      expect(found[0]).toMatchObject({ value: text, suggestedName: name });
    }
  });

  test("a keyword just before a token turns an otherwise plain value into a finding", () => {
    const hex32 = "0123456789abcdef0123456789abcdef"; // single case, hex-only: looksRandom alone misses it
    for (const line of [
      `api_key=${hex32}`, `apikey: ${hex32}`, `token ${hex32}`, `secret="${hex32}"`,
      `password: '${hex32}'`, `passwd=${hex32}`, `pwd ${hex32}`, `auth: ${hex32}`, `Bearer ${hex32}`,
    ]) {
      const found = secretFindings(line);
      expect(found, line).toMatchObject([{ value: hex32, kind: "key-like value", suggestedName: "secret" }]);
    }
    // under 32 chars, with no known prefix: also missed without the keyword.
    const short = "AbCdEf1234567890"; // 16 chars, mixed case + digit
    expect(looksRandom(short)).toBe(false);
    expect(secretFindings(`key: ${short}`)).toMatchObject([{ value: short, kind: "key-like value" }]);
  });

  test("a context keyword does not re-label a value the fallback already caught", () => {
    const random = "Zq8vLm3TxR7kPw2NcY6bHs9JdF4gUa1E"; // same as the fallback's own test case
    expect(secretFindings(`token ${random}`)).toMatchObject([{ value: random, kind: "long random string" }]);
  });

  test("the keyword rule needs a digit in the value: plain prose is not held", () => {
    expect(secretFindings("the token internationalization is held")).toEqual([]);
  });

  test("a base64 data URI payload is not held, by the fallback or the keyword rule", () => {
    // High entropy, mixed case plus digits: the fallback alone would hold this as a long random string.
    const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mJk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    expect(looksRandom(payload)).toBe(true);
    expect(secretFindings(`data:image/png;base64,${payload}`)).toEqual([]);
    expect(secretFindings(`key: data:image/png;base64,${payload}`)).toEqual([]);
  });

  test("the keyword separator caps its spaces at three on each side: far more is not held", () => {
    const hex32 = "0123456789abcdef0123456789abcdef";
    expect(secretFindings(`token${" ".repeat(10)}${hex32}`)).toEqual([]); // past the cap on both sides
    expect(secretFindings(`token   ${hex32}`)).toMatchObject([{ value: hex32 }]); // 3 spaces: still held
  });

  test("a commit sha, a UUID, a path, English prose and a base64 image prefix are not held", () => {
    for (const text of [
      "commit 3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c2d4e6f8a0b", // a sha alone, no keyword
      "id 123e4567-e89b-12d3-a456-426614174000", // a UUID alone, no keyword
      "src/components/very/long/path/ChatComposerPasteGuard.tsx", // a file path
      "ThisIsALongDescriptiveVariableNameThatSomeoneMightWriteInCode", // a normal long English word run
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA", // a base64 image prefix
    ]) expect(secretFindings(text)).toEqual([]);
  });

  test("replaceFindings swaps each finding, the rest kept", () => {
    const text = "a AKIAIOSFODNN7EXAMPLE b xoxb-1234567890-abcdefghij c";
    expect(replaceFindings(text, secretFindings(text), (_, i) => `[secret ${i}]`)).toBe("a [secret 0] b [secret 1] c");
  });
});

describe("scrub", () => {
  const stored = [{ ref: "api_key", value: "sk-test-123456" }, { ref: "chat/long", value: "sk-test-123456-and-more" }, { ref: "pin", value: "1234" }];
  test("every stored value becomes its name; the longest first; a short value is left", () => {
    expect(scrubSecrets("key=sk-test-123456-and-more and sk-test-123456, pin 1234", stored)).toBe("key=[secret chat/long] and [secret api_key], pin 1234");
    expect(scrubDeep({ a: ["x sk-test-123456"], b: { c: "sk-test-123456" }, n: 3 }, stored)).toEqual({ a: ["x [secret api_key]"], b: { c: "[secret api_key]" }, n: 3 });
    expect(scrubSecrets("nothing here", stored)).toBe("nothing here");
  });
});
