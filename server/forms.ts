// Forms in the chat: `orca ask-form` asks the user for structured data. The form is a row (`form`);
// the chat draws it as a card under the turn that asked it (linked by the `orca-form://<id>` line the
// tool prints, like a handoff pack); the user's submit stores each secret field in the secret store
// (server/secrets.ts) and wakes the orchestrator with the rest as JSON. The pure rules are in
// shared/forms.ts.
//
// A channel (Discord, Slack, email…) never gets a field: the `orca.question` event carries only the
// title, the intro and a link to the Orca chat (formChannelText).
import type { AgentTurn } from "../shared/agent";
import {
  answerErrors, firstRunPerForm, formAnswerMessage, formCancelMessage, formChannelText, formRef, parseFormSpec,
  splitAnswers, type FormSpec, type FormView,
} from "../shared/forms";
import type { OrcaConfig } from "./config";
import * as db from "./db";
import * as integrationRouter from "./integrations/router";
import * as secrets from "./secrets";
import { selfServer } from "./servers";

export class FormError extends Error {
  constructor(message: string, readonly status = 400, readonly errors?: Record<string, string>) { super(message); }
}

const view = (r: db.FormRow): FormView => ({
  id: r.id, title: r.title, ...(r.intro ? { intro: r.intro } : {}), ...(r.scope ? { scope: r.scope } : {}),
  fields: r.fields as FormSpec["fields"], state: r.state,
  ...(r.answers ? { answers: r.answers as FormView["answers"] } : {}), createdAt: r.createdAt, ...(r.answeredAt ? { answeredAt: r.answeredAt } : {}),
});

/** The Orca chat's address for a channel's link: this server's url + /orchestrator. */
async function chatUrl(cfg: OrcaConfig): Promise<string | undefined> {
  try { return `${(await selfServer(cfg.serverSwitcher ?? {})).url.replace(/\/$/, "")}/orchestrator`; } catch { return undefined; }
}

/** Make a form from a checked spec and tell the user: the bell, the Inbox and every channel
 *  subscribed to `orca.question` — channels with only a link. Returns the form. */
export async function ask(cfg: OrcaConfig, spec: FormSpec): Promise<FormView> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await db.addForm({ id, title: spec.title, ...(spec.intro ? { intro: spec.intro } : {}), ...(spec.scope ? { scope: spec.scope } : {}), fields: spec.fields, createdAt });
  await integrationRouter.publish({
    key: `form:${id}`, topic: "orca.question", at: createdAt, source: { adapter: "orca" },
    title: "The orchestrator asks you to fill in a form", text: formChannelText(spec, await chatUrl(cfg)), link: { orchestrator: true },
  }, createdAt, [{ subscriptionId: null, target: { kind: "web" } }]);
  return { ...spec, id, state: "open", createdAt };
}

/** `orca ask-form` → the text the tool prints: the form's reference line, and what comes back. */
export function askedText(f: FormView): string {
  const secretsIn = f.fields.filter((x) => x.type === "secret").map((x) => x.name);
  return [
    `Asked: form "${f.title}" with ${f.fields.length} field${f.fields.length === 1 ? "" : "s"}. ${formRef(f.id)}`,
    "The user fills it in the Orca chat (a channel gets only a link). End your turn; the answers come as a message, as JSON.",
    ...(secretsIn.length ? [`Secret fields (${secretsIn.join(", ")}) come back as {"name": …, "stored": true}: use them with orca secret pipe|env, never ask for the value.`] : []),
  ].join("\n");
}

export async function one(id: string): Promise<FormView | undefined> {
  const r = await db.form(id);
  return r && view(r);
}

type Wake = (text: string) => Promise<unknown>;

/** The user's submit: check the answers, store each secret field, close the form, wake the
 *  orchestrator with the rest. The wake text never holds a secret (splitAnswers). A form that is not
 *  open is a 409; invalid answers are a 400 with each field's message. */
export async function submit(id: string, values: Record<string, unknown>, wake: Wake): Promise<FormView> {
  const r = await db.form(id);
  if (!r) throw new FormError(`no form ${id}`, 404);
  if (r.state !== "open") throw new FormError(`this form is already ${r.state}`, 409);
  const f = view(r);
  const errors = answerErrors(f, values);
  if (Object.keys(errors).length) throw new FormError(`fix the form: ${Object.entries(errors).map(([k, v]) => `${k} ${v}`).join("; ")}`, 400, errors);
  const { answers, secrets: toStore } = splitAnswers(f, values);
  // Close first: a double click must not store twice or wake twice.
  if (!(await db.closeForm(id, "submitted", answers))) throw new FormError("this form is already answered", 409);
  for (const s of toStore) await secrets.store({ scope: s.scope, name: s.name, value: s.value, who: "user (form)", source: `form ${id}` });
  await wake(formAnswerMessage(f, answers));
  return { ...f, state: "submitted", answers, answeredAt: Date.now() };
}

export async function cancel(id: string, wake: Wake): Promise<FormView> {
  const r = await db.form(id);
  if (!r) throw new FormError(`no form ${id}`, 404);
  if (!(await db.closeForm(id, "cancelled", null))) throw new FormError(`this form is already ${r.state}`, 409);
  const f = view(r);
  await wake(formCancelMessage(f));
  return { ...f, state: "cancelled", answeredAt: Date.now() };
}

/** Sets `forms` on each turn that asked one (its tool results name it), each form on the first
 *  turn that names it. One query for the page. */
export async function linkTurns(turns: AgentTurn[]): Promise<void> {
  const byRun = firstRunPerForm(await db.formOutputs(turns.map((t) => t.id)));
  for (const t of turns) {
    const ids = byRun.get(t.id);
    if (ids) t.forms = ids;
  }
}

/** `--fields <json|@file>` → the parsed JSON. `@file` is read relative to the caller's cwd. */
export async function readFieldsArg(raw: unknown, cwd?: string): Promise<unknown> {
  if (typeof raw !== "string" || !raw.trim()) throw new FormError('--fields is required: a JSON array of fields, or @file. Example: --fields \'[{"name":"email","label":"Email","type":"email","required":true}]\'');
  let text = raw.trim();
  if (text.startsWith("@")) {
    const path = text.slice(1);
    const file = Bun.file(path.startsWith("/") || !cwd ? path : `${cwd}/${path}`);
    if (!(await file.exists())) throw new FormError(`--fields ${text}: no such file`);
    text = await file.text();
  }
  try { return JSON.parse(text); } catch (e) { throw new FormError(`--fields is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
}

/** `orca ask-form --title … [--intro …] [--scope …] --fields <json|@file>` → a checked spec. */
export async function specFromArgs(args: Record<string, unknown>): Promise<FormSpec> {
  const fields = await readFieldsArg(args.fields, typeof args._cwd === "string" ? args._cwd : undefined);
  return parseFormSpec({ title: args.title, intro: args.intro, scope: args.scope, fields });
}
