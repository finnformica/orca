// The form card (`orca ask-form`): drawn in the orchestrator's chat under the turn that asked it, in
// the same place as a handoff pack's row. One input per field type, the shared checks of
// shared/forms.ts, Submit and Cancel. A secret field is a masked input with a reveal toggle; its value
// goes only to the submit route, which stores it (server/secrets.ts) — never into the chat, the
// transcript or the wake text. An answered form shows its answers, a secret as "stored".
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ClipboardList, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DatePicker, DateTimePicker } from "./DateField";
import { api } from "../api";
import { answerErrors, type FormAnswers, type FormField, type FormView } from "../../../shared/forms";

type Values = Record<string, unknown>;

/** The starting value of each field: its default, else empty (a checkbox unticked, a multiselect none). */
export function initialValues(fields: FormField[]): Values {
  const out: Values = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.type === "number" ? String(f.default) : f.default;
    else out[f.name] = f.type === "checkbox" ? false : f.type === "multiselect" ? [] : "";
  }
  return out;
}

export function FormCard({ id }: { id: string }) {
  const [form, setForm] = useState<FormView | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string>();
  const load = useCallback(() => api.form(id).then((d) => { setForm(d?.form ?? null); setLoadError(undefined); }).catch((e) => setLoadError(e instanceof Error ? e.message : String(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  if (form === null) return <div data-slot="chat-form" data-state="missing" className="bg-card text-muted-foreground mt-2 rounded-md border px-3 py-2 text-xs">This form is gone.</div>;
  if (!form) return <div data-slot="chat-form" data-state="loading" className="bg-card text-muted-foreground mt-2 rounded-md border px-3 py-2 text-xs">{loadError ? `Cannot load the form: ${loadError}` : "Loading the form…"}</div>;
  return <FormBody form={form} onDone={setForm} />;
}

/** The card for a loaded form. Exported for the tests and the screenshot harness. */
export function FormBody({ form, onDone }: { form: FormView; onDone: (f: FormView) => void }) {
  const [values, setValues] = useState<Values>(() => initialValues(form.fields));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"submit" | "cancel" | null>(null);
  const [error, setError] = useState<string>();
  const errors = { ...answerErrors(form, values), ...serverErrors };
  const set = (name: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [name]: v }));
    setServerErrors((prev) => { const { [name]: _, ...rest } = prev; return rest; });
  };
  const open = form.state === "open";

  const submit = async () => {
    setTried(true);
    if (Object.keys(answerErrors(form, values)).length) return;
    setBusy("submit"); setError(undefined);
    try {
      const r = await api.submitForm(form.id, values);
      // The secret values leave this component's state at once.
      setValues(initialValues(form.fields));
      onDone(r.form);
    } catch (e) {
      const fieldErrors = (e as { errors?: Record<string, string> }).errors;
      if (fieldErrors) setServerErrors(fieldErrors);
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };
  const cancel = async () => {
    setBusy("cancel"); setError(undefined);
    try { onDone((await api.cancelForm(form.id)).form); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  return (
    <div data-slot="chat-form" data-state={form.state} className="bg-card mt-2 rounded-md border text-[13px]">
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <span className="flex h-5 shrink-0 items-center"><ClipboardList className="text-muted-foreground size-4" /></span>
        <div className="min-w-0 flex-1">
          <div data-slot="form-title" className="leading-5 font-medium break-words">{form.title}</div>
          {form.intro && <p className="text-muted-foreground mt-0.5 text-xs whitespace-pre-wrap">{form.intro}</p>}
        </div>
        {!open && <span data-slot="form-state" className="bg-accent text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px]">{form.state === "submitted" ? "Submitted" : "Cancelled"}</span>}
      </div>
      {open ? (
        <form
          className="space-y-3 px-3 py-3"
          noValidate
          autoComplete="off"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          {form.fields.map((f) => (
            <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} onBlur={() => setTouched((t) => ({ ...t, [f.name]: true }))}
              error={(tried || touched[f.name] || serverErrors[f.name]) ? errors[f.name] : undefined} />
          ))}
          {error && <p data-slot="form-error" className="text-destructive text-xs break-words">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => void cancel()} data-slot="form-cancel">
              {busy === "cancel" && <Loader2 className="size-3.5 animate-spin" />}Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!!busy} data-slot="form-submit">
              {busy === "submit" && <Loader2 className="size-3.5 animate-spin" />}Submit
            </Button>
          </div>
        </form>
      ) : form.state === "submitted" ? <Answers form={form} answers={form.answers ?? {}} /> : (
        <p className="text-muted-foreground px-3 py-2.5 text-xs">You cancelled this form.</p>
      )}
    </div>
  );
}

/** An answered form: each field's label and answer. A secret shows only that it was stored. */
function Answers({ form, answers }: { form: FormView; answers: FormAnswers }) {
  return (
    <dl data-slot="form-answers" className="divide-y">
      {form.fields.map((f) => {
        const a = answers[f.name];
        const shown: ReactNode = a && typeof a === "object" && !Array.isArray(a) && "stored" in a
          ? <span className="inline-flex items-center gap-1"><KeyRound className="size-3.5" />Stored as secret <code className="font-mono text-xs">{a.name}</code></span>
          : Array.isArray(a) ? (a.length ? a.map((v) => f.options?.find((o) => o.value === v)?.label ?? v).join(", ") : "—")
          : typeof a === "boolean" ? (a ? "Yes" : "No")
          : a === null || a === undefined || a === "" ? "—"
          : f.type === "select" ? (f.options?.find((o) => o.value === a)?.label ?? String(a)) : String(a);
        return (
          <div key={f.name} className="flex gap-3 px-3 py-1.5">
            <dt className="text-muted-foreground w-1/3 shrink-0 truncate text-xs leading-5">{f.label}</dt>
            <dd className="min-w-0 flex-1 break-words">{shown}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Field({ field: f, value, onChange, onBlur, error }: { field: FormField; value: unknown; onChange: (v: unknown) => void; onBlur: () => void; error?: string }) {
  const id = useId();
  const helpId = `${id}-help`, errId = `${id}-err`;
  const described = [f.help ? helpId : "", error ? errId : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, name: f.name, "aria-invalid": error ? true : undefined, "aria-describedby": described, "aria-required": f.required || undefined, onBlur };
  const str = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const label = (
    <label htmlFor={f.type === "multiselect" ? undefined : id} className="text-xs font-medium">
      {f.label}{f.required && <span className="text-destructive ml-0.5" aria-hidden>*</span>}
    </label>
  );
  let input: ReactNode;
  switch (f.type) {
    case "textarea":
      input = <Textarea {...common} rows={3} className="min-h-16 text-sm" placeholder={f.placeholder} value={str} onChange={(e) => onChange(e.target.value)} maxLength={typeof f.max === "number" ? f.max : undefined} />;
      break;
    case "select":
      input = <FieldSelect common={common} field={f} value={str} onChange={onChange} />;
      break;
    case "date":
      input = <DatePicker common={common} value={str} onChange={onChange} min={f.min} max={f.max} required={f.required} placeholder={f.placeholder} />;
      break;
    case "datetime":
      input = <DateTimePicker common={common} value={str} onChange={onChange} min={f.min} max={f.max} required={f.required} />;
      break;
    case "multiselect": {
      const chosen = Array.isArray(value) ? (value as string[]) : [];
      input = (
        <div role="group" aria-labelledby={`${id}-label`} aria-describedby={described} className="flex flex-wrap gap-x-4 gap-y-1.5" data-slot="form-multiselect">
          {f.options?.map((o) => (
            <label key={o.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={chosen.includes(o.value)} onBlur={onBlur}
                onCheckedChange={(c) => onChange(c ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))} aria-invalid={error ? true : undefined} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case "checkbox":
      return (
        <div data-slot="form-field" data-type={f.type}>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...common} checked={value === true} onCheckedChange={(c) => onChange(c === true)} />
            <span>{f.label}{f.required && <span className="text-destructive ml-0.5" aria-hidden>*</span>}</span>
          </label>
          <Hint f={f} helpId={helpId} errId={errId} error={error} />
        </div>
      );
    case "secret":
      input = <SecretInput common={common} placeholder={f.placeholder} value={str} onChange={onChange} />;
      break;
    default: {
      const type = f.type === "text" ? "text" : f.type;
      const bounds = f.type === "number" ? { min: f.min, max: f.max } : { maxLength: typeof f.max === "number" ? f.max : undefined };
      // A number keeps its arrow keys but not the browser's spinner, which clashes with the Input.
      input = <Input {...common} type={type} inputMode={f.type === "number" ? "decimal" : undefined} placeholder={f.placeholder} value={str} onChange={(e) => onChange(e.target.value)} {...bounds}
        className={f.type === "number" ? "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" : undefined} />;
    }
  }
  return (
    <div data-slot="form-field" data-type={f.type} className="space-y-1">
      <div id={`${id}-label`}>{label}</div>
      {input}
      <Hint f={f} helpId={helpId} errId={errId} error={error} />
    </div>
  );
}

function Hint({ f, helpId, errId, error }: { f: FormField; helpId: string; errId: string; error?: string }) {
  return (
    <>
      {f.help && <p id={helpId} className="text-muted-foreground text-xs">{f.help}</p>}
      {error && <p id={errId} data-slot="form-field-error" className="text-destructive text-xs">{f.label} {error}</p>}
    </>
  );
}

/** A masked input with a reveal toggle. The browser must not save it: no autocomplete, no spellcheck. */
/** The masked value field with its reveal toggle — also the composer's `/secret` widget's (components/SlashCommands). */
// `compact` (the composer's card): no hint line, and the reveal toggle is out of the Tab order.
export function SecretInput({ common, placeholder, value, onChange, compact }: { common: Record<string, unknown>; placeholder?: string; value: string; onChange: (v: string) => void; compact?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative" data-slot="form-secret">
      <Input {...common} type={shown ? "text" : "password"} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true"
        placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className={cn("pr-9 font-mono")} />
      <Button type="button" size="icon" variant="ghost" className="text-muted-foreground absolute top-0 right-0 size-8" aria-label={shown ? "Hide the value" : "Show the value"} aria-pressed={shown}
        tabIndex={compact ? -1 : undefined} data-slot="form-secret-reveal" onClick={() => setShown(!shown)}>
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
      {!compact && <p className="text-muted-foreground mt-1 flex items-center gap-1 text-[11px]"><KeyRound className="size-3" />Stored encrypted. The agent sees only its name.</p>}
    </div>
  );
}


/** The value of the "no choice" item: Radix gives an item no empty value, so an optional select clears
 *  through this one. Never a form answer: it maps back to "". */
const NO_CHOICE = "__orca_no_choice__";

/** A select field: shadcn's Select. Its trigger takes the field's id (the label's htmlFor), name and
 *  ARIA. Its close counts as the field's blur, so the "required" error waits for a choice. */
function FieldSelect({ common, field: f, value, onChange }: { common: Record<string, unknown> & { onBlur: () => void }; field: FormField; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const { onBlur, ...trigger } = common;
  return (
    <Select value={value} onValueChange={(v) => onChange(v === NO_CHOICE ? "" : v)} open={open} onOpenChange={(o) => { setOpen(o); if (!o) onBlur(); }}>
      <SelectTrigger {...trigger} data-slot="form-select" data-value={value} onBlur={() => { if (!open) onBlur(); }}
        className="aria-invalid:border-geist-red data-[placeholder]:text-muted-foreground w-full text-base md:text-sm">
        <SelectValue placeholder={f.placeholder ?? "Choose…"} />
      </SelectTrigger>
      <SelectContent className="min-w-(--radix-select-trigger-width)">
        {!f.required && value && <SelectItem value={NO_CHOICE} className="text-muted-foreground">None</SelectItem>}
        {f.options?.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
