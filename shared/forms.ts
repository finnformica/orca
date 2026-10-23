// Forms in the chat (`orca ask-form`): an agent asks the user for structured data. The spec is
// checked here, the answers are checked here, and the text that wakes the orchestrator is made here,
// so the bridge (server/forms.ts) and the chat's form card (web FormCard) can never disagree. Pure.
//
// A `secret` field is the one type whose value never leaves the bridge: the submit route stores it
// in the encrypted secret store (server/secrets.ts) and the answers carry only `{ name, stored: true }`.

export const FIELD_TYPES = ["text", "textarea", "number", "date", "datetime", "select", "multiselect", "checkbox", "url", "email", "secret"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldOption = { value: string; label: string };

export type FormField = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** Not allowed on a secret field: a secret is never in the spec. */
  default?: string | number | boolean | string[];
  /** select / multiselect only. A bare string is its own label. */
  options?: FieldOption[];
  /** number: the value. text, textarea, secret: the length. multiselect: the count. date / datetime: ISO text. */
  min?: number | string;
  max?: number | string;
  /** secret only: the secret's scope in the store (the form's scope when absent). */
  scope?: string;
};

export type FormSpec = { title: string; intro?: string; scope?: string; fields: FormField[] };

/** A stored secret as the agent sees it: never the value. */
export type StoredSecretAnswer = { name: string; stored: true };
export type FormAnswers = Record<string, string | number | boolean | string[] | null | StoredSecretAnswer>;

export const FORM_MAX_FIELDS = 30;
export const DEFAULT_SECRET_SCOPE = "default";
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const SCOPE = /^[A-Za-z0-9_.-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_KEYS = new Set(["name", "label", "type", "required", "help", "placeholder", "default", "options", "min", "max", "scope"]);

/** The reference `orca secret` takes for a stored secret: the name alone in the default scope, else `scope/name`. */
export const secretRef = (scope: string, name: string): string => (scope === DEFAULT_SECRET_SCOPE ? name : `${scope}/${name}`);

const isStr = (v: unknown): v is string => typeof v === "string";
const validDate = (s: string, withTime: boolean): boolean => (withTime ? DATETIME : DATE).test(s) && !Number.isNaN(Date.parse(withTime ? s : `${s}T00:00`));

/** A form spec from the CLI's JSON, checked. Throws one message that lists every problem, written
 *  for the model to fix. `fields` may be the array itself or `{ fields: [...] }`. */
export function parseFormSpec(input: { title?: unknown; intro?: unknown; scope?: unknown; fields?: unknown }): FormSpec {
  const problems: string[] = [];
  const title = isStr(input.title) ? input.title.trim() : "";
  if (!title) problems.push("--title is required");
  else if (title.length > 200) problems.push("--title is longer than 200 characters");
  const intro = isStr(input.intro) && input.intro.trim() ? input.intro.trim() : undefined;
  if (intro && intro.length > 2000) problems.push("--intro is longer than 2000 characters");
  const scope = isStr(input.scope) && input.scope.trim() ? input.scope.trim() : undefined;
  if (scope && !SCOPE.test(scope)) problems.push(`--scope "${scope}" must be 1-64 letters, digits, "_", "." or "-"`);
  let raw = input.fields;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { fields?: unknown }).fields)) raw = (raw as { fields: unknown }).fields;
  if (!Array.isArray(raw) || !raw.length) {
    problems.push("--fields must be a non-empty JSON array of fields");
    throw new Error(`invalid form: ${problems.join("; ")}`);
  }
  if (raw.length > FORM_MAX_FIELDS) problems.push(`a form has at most ${FORM_MAX_FIELDS} fields (got ${raw.length})`);
  const seen = new Set<string>();
  const fields: FormField[] = [];
  raw.forEach((f, i) => {
    const at = `field ${i + 1}`;
    if (!f || typeof f !== "object" || Array.isArray(f)) { problems.push(`${at} is not an object`); return; }
    const o = f as Record<string, unknown>;
    const id = isStr(o.name) ? `field "${o.name}"` : at;
    for (const k of Object.keys(o)) if (!FIELD_KEYS.has(k)) problems.push(`${id}: unknown key "${k}"`);
    if (!isStr(o.name) || !NAME.test(o.name)) problems.push(`${at}: "name" must start with a letter or "_" and use only letters, digits, "_", "." or "-" (at most 64)`);
    else if (seen.has(o.name)) problems.push(`${id}: the name is used twice`);
    else seen.add(o.name);
    const label = isStr(o.label) ? o.label.trim() : "";
    if (!label) problems.push(`${id}: "label" is required`);
    const type = o.type as FieldType;
    if (!FIELD_TYPES.includes(type)) { problems.push(`${id}: "type" must be one of ${FIELD_TYPES.join(", ")}`); return; }
    for (const k of ["help", "placeholder"] as const) if (o[k] !== undefined && !isStr(o[k])) problems.push(`${id}: "${k}" must be text`);
    if (o.required !== undefined && typeof o.required !== "boolean") problems.push(`${id}: "required" must be true or false`);
    // Options: select and multiselect need them; no other type takes them.
    let options: FieldOption[] | undefined;
    if (type === "select" || type === "multiselect") {
      if (!Array.isArray(o.options) || !o.options.length) problems.push(`${id}: a ${type} needs "options" (a non-empty array)`);
      else {
        options = [];
        for (const opt of o.options) {
          if (isStr(opt) && opt) options.push({ value: opt, label: opt });
          else if (opt && typeof opt === "object" && isStr((opt as FieldOption).value) && (opt as FieldOption).value) {
            const v = opt as { value: string; label?: unknown };
            options.push({ value: v.value, label: isStr(v.label) && v.label ? v.label : v.value });
          } else problems.push(`${id}: each option is text or { "value", "label" }`);
        }
        if (new Set(options.map((x) => x.value)).size !== options.length) problems.push(`${id}: option values must be unique`);
      }
    } else if (o.options !== undefined) problems.push(`${id}: only select and multiselect take "options"`);
    // min / max: their meaning follows the type.
    for (const k of ["min", "max"] as const) {
      const v = o[k];
      if (v === undefined) continue;
      if (type === "date" || type === "datetime") { if (!isStr(v) || !validDate(v, type === "datetime")) problems.push(`${id}: "${k}" must be a ${type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:MM"} date`); }
      else if (["number", "text", "textarea", "secret", "multiselect"].includes(type)) { if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`${id}: "${k}" must be a number`); }
      else problems.push(`${id}: a ${type} field takes no "${k}"`);
    }
    if (o.min !== undefined && o.max !== undefined && (o.min as number) > (o.max as number)) problems.push(`${id}: "min" is greater than "max"`);
    if (o.scope !== undefined) {
      if (type !== "secret") problems.push(`${id}: only a secret field takes "scope"`);
      else if (!isStr(o.scope) || !SCOPE.test(o.scope)) problems.push(`${id}: "scope" must be 1-64 letters, digits, "_", "." or "-"`);
    }
    // A default must itself be a valid answer. A secret never has one: the spec is not secret.
    if (o.default !== undefined) {
      if (type === "secret") problems.push(`${id}: a secret field takes no "default" (the spec is not secret)`);
      else {
        const err = fieldError({ name: String(o.name), label, type, options, min: o.min as number, max: o.max as number }, o.default);
        if (err) problems.push(`${id}: "default" is not valid: ${err}`);
      }
    }
    fields.push({
      name: String(o.name), label, type,
      ...(o.required === true ? { required: true } : {}),
      ...(isStr(o.help) && o.help ? { help: o.help } : {}),
      ...(isStr(o.placeholder) && o.placeholder ? { placeholder: o.placeholder } : {}),
      ...(o.default !== undefined && type !== "secret" ? { default: o.default as FormField["default"] } : {}),
      ...(options ? { options } : {}),
      ...(o.min !== undefined ? { min: o.min as number | string } : {}),
      ...(o.max !== undefined ? { max: o.max as number | string } : {}),
      ...(type === "secret" && isStr(o.scope) ? { scope: o.scope } : {}),
    });
  });
  if (problems.length) throw new Error(`invalid form: ${problems.join("; ")}`);
  return { title, ...(intro ? { intro } : {}), ...(scope ? { scope } : {}), fields };
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/** Why one field's value is invalid, or undefined. An empty value is valid here: `required` is the
 *  caller's check (answerErrors). Pure; the web card and the submit route both call it. */
export function fieldError(f: Pick<FormField, "name" | "label" | "type" | "options" | "min" | "max">, v: unknown): string | undefined {
  const min = f.min, max = f.max;
  // Empty is valid here, except a multiselect with a `min`: the agent asked for at least that many.
  if (empty(v) && !(f.type === "multiselect" && typeof min === "number" && min > 0)) return undefined;
  switch (f.type) {
    case "text": case "textarea": case "secret": {
      if (!isStr(v)) return "must be text";
      if (typeof min === "number" && v.length < min) return `must be at least ${min} characters`;
      if (typeof max === "number" && v.length > max) return `must be at most ${max} characters`;
      return undefined;
    }
    case "number": {
      const n = typeof v === "number" ? v : isStr(v) && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) return "must be a number";
      if (typeof min === "number" && n < min) return `must be ${min} or more`;
      if (typeof max === "number" && n > max) return `must be ${max} or less`;
      return undefined;
    }
    case "date": case "datetime": {
      const withTime = f.type === "datetime";
      if (!isStr(v) || !validDate(v, withTime)) return `must be a date (${withTime ? "YYYY-MM-DDTHH:MM" : "YYYY-MM-DD"})`;
      if (isStr(min) && v < min) return `must be ${min} or later`;
      if (isStr(max) && v > max) return `must be ${max} or earlier`;
      return undefined;
    }
    case "select":
      return isStr(v) && f.options?.some((o) => o.value === v) ? undefined : "must be one of the options";
    case "multiselect": {
      if (v === undefined || v === null || v === "") v = [];
      if (!Array.isArray(v) || !v.every((x) => isStr(x) && f.options?.some((o) => o.value === x))) return "must be a list of the options";
      if (typeof min === "number" && v.length < min) return `choose at least ${min}`;
      if (typeof max === "number" && v.length > max) return `choose at most ${max}`;
      return undefined;
    }
    case "checkbox":
      return typeof v === "boolean" ? undefined : "must be true or false";
    case "url": {
      if (!isStr(v)) return "must be a URL";
      try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:" ? undefined : "must be an http(s) URL"; } catch { return "must be a URL"; }
    }
    case "email":
      return isStr(v) && EMAIL.test(v) ? undefined : "must be an email address";
  }
}

/** Each invalid or missing field's message, by name. Empty when the answers can be submitted. A
 *  required checkbox must be ticked. Pure. */
export function answerErrors(spec: Pick<FormSpec, "fields">, values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = values[f.name];
    if (f.required && (empty(v) || (f.type === "checkbox" && v !== true))) { out[f.name] = "is required"; continue; }
    const err = fieldError(f, v);
    if (err) out[f.name] = err;
  }
  return out;
}

/** The secret's scope for a field: its own, else the form's, else the default. */
export const fieldScope = (spec: Pick<FormSpec, "scope">, f: Pick<FormField, "scope">): string => f.scope ?? spec.scope ?? DEFAULT_SECRET_SCOPE;

/** The answers the agent gets: every non-secret value, normalised (a number field as a number, an
 *  empty field as null), and each secret field as `{ name, stored: true }` — or null when it was left
 *  empty. `secrets` lists the secret fields to store, with their values; it never goes to the agent. Pure. */
export function splitAnswers(spec: FormSpec, values: Record<string, unknown>): { answers: FormAnswers; secrets: { field: string; scope: string; name: string; value: string }[] } {
  const answers: FormAnswers = {};
  const secrets: { field: string; scope: string; name: string; value: string }[] = [];
  for (const f of spec.fields) {
    const v = values[f.name];
    if (f.type === "secret") {
      if (isStr(v) && v) {
        const scope = fieldScope(spec, f);
        secrets.push({ field: f.name, scope, name: f.name, value: v });
        answers[f.name] = { name: secretRef(scope, f.name), stored: true };
      } else answers[f.name] = null;
      continue;
    }
    if (empty(v)) answers[f.name] = f.type === "checkbox" ? false : null;
    else if (f.type === "number") answers[f.name] = typeof v === "number" ? v : Number(v);
    else answers[f.name] = v as string | boolean | string[];
  }
  return { answers, secrets };
}

/** The message that wakes the orchestrator with a form's answers: the form, its answers as JSON
 *  (secrets as `{ name, stored: true }`) and how to use a stored secret. No secret value can reach
 *  it: `answers` comes from splitAnswers. Pure. */
export function formAnswerMessage(form: { id: string; title: string }, answers: FormAnswers): string {
  const stored = Object.values(answers).filter((v): v is StoredSecretAnswer => !!v && typeof v === "object" && !Array.isArray(v) && (v as StoredSecretAnswer).stored === true);
  return [
    `[form answered] ${form.title} (form ${form.id})`,
    "```json",
    JSON.stringify(answers, null, 2),
    "```",
    ...(stored.length ? [`Stored secrets: ${stored.map((s) => s.name).join(", ")}. Use them with \`orca secret pipe <name> -- <cmd…>\` or \`orca secret env <name>[=VAR] -- <cmd…>\`. You never see a value: do not ask the user for it.`] : []),
  ].join("\n");
}

export const formCancelMessage = (form: { id: string; title: string }): string => `[form cancelled] ${form.title} (form ${form.id}): the user cancelled the form. No answers were given.`;

/** The link from a turn to the form it asked: `orca ask-form` prints it with the form's id, and the
 *  run's tool-result step stores it, so the chat finds the form by id (like orca-handoff://). */
export const FORM_REF = "orca-form://";
export const formRef = (id: string): string => `${FORM_REF}${id}`;

/** Every form id referenced in a text, in order, each once. Pure. */
export function formRefs(text: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/orca-form:\/\/([\w-]{8,64})/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** The forms a turn asked: the ids the bridge linked (`turn.forms`), plus any in its loaded tool
 *  results — a running turn shows its form before the next page read links it. Pure. */
export function turnForms(turn: { forms?: string[]; steps?: { kind: string; output?: string; isError?: boolean }[] }): string[] {
  const out = [...(turn.forms ?? [])];
  for (const s of turn.steps ?? []) if (s.kind === "result" && !s.isError) for (const id of formRefs(s.output)) if (!out.includes(id)) out.push(id);
  return out;
}

/** Each form id to the FIRST run whose tool results name it (runs oldest first). Pure. */
export function firstRunPerForm(outputs: { runId: string; output: string }[]): Map<string, string[]> {
  const seen = new Set<string>(), out = new Map<string, string[]>();
  for (const { runId, output } of outputs) {
    for (const id of formRefs(output)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.set(runId, [...(out.get(runId) ?? []), id]);
    }
  }
  return out;
}

/** What a channel (Discord, Slack, email…) gets for a form: the title, the intro and a link to the
 *  Orca chat — never a field. A secret field can only be filled in the Orca chat. Pure. */
export function formChannelText(form: { title: string; intro?: string }, url: string | undefined): string {
  return [
    `The orchestrator asks you to fill in a form: ${form.title}.`,
    ...(form.intro ? [form.intro] : []),
    url ? `Open the Orca chat to answer: ${url}` : "Open the Orca chat to answer.",
  ].join("\n");
}

/** The form as the chat shows it. `answers` has no secret value (splitAnswers). */
export type FormView = FormSpec & {
  id: string;
  state: "open" | "submitted" | "cancelled";
  answers?: FormAnswers;
  createdAt: number;
  answeredAt?: number;
};
