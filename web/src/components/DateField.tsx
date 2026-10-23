// The form card's date and date+time pickers: shadcn's Calendar in a Popover, behind a button that
// looks like an Input, in place of the browser's own `type=date` / `datetime-local` picker. The value
// stays the text the form's answers carry (shared/forms.ts): `YYYY-MM-DD`, and `YYYY-MM-DDTHH:MM`.
import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import type { Matcher } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of a local date. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The local date of the `YYYY-MM-DD` at the start of `s`, else undefined. */
export function parseDay(s: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The days outside `min` / `max` (ISO text; a datetime bound counts by its day). */
function outOfBounds(min: unknown, max: unknown): Matcher[] {
  const out: Matcher[] = [];
  const lo = typeof min === "string" ? parseDay(min) : undefined;
  const hi = typeof max === "string" ? parseDay(max) : undefined;
  if (lo) out.push({ before: lo });
  if (hi) out.push({ after: hi });
  return out;
}

type Common = { id: string; name: string; "aria-invalid"?: boolean; "aria-describedby"?: string; onBlur: () => void };

/** The props an Input-like trigger gets: the field's id (for the label's htmlFor), name and ARIA. */
const triggerProps = ({ onBlur: _, "aria-required": __, ...rest }: Common & Record<string, unknown>) => rest;

const TRIGGER = "border-input aria-invalid:border-geist-red h-8 w-full justify-start gap-2 px-2 text-base font-normal md:text-sm";

/** A date as `YYYY-MM-DD`. The popover closes on a pick; its close counts as the field's blur. */
export function DatePicker({ common, value, onChange, min, max, required, placeholder, className }: {
  common: Common; value: string; onChange: (v: string) => void; min?: unknown; max?: unknown; required?: boolean; placeholder?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const day = parseDay(value);
  const setOpenAndBlur = (o: boolean) => { setOpen(o); if (!o) common.onBlur(); };
  return (
    <Popover open={open} onOpenChange={setOpenAndBlur}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" data-slot="form-date" data-value={value} {...triggerProps(common)}
          onBlur={() => { if (!open) common.onBlur(); }} className={cn(TRIGGER, className)}>
          <CalendarIcon className="text-muted-foreground size-4" />
          <span className={cn("truncate", !day && "text-muted-foreground")}>
            {day ? day.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : placeholder ?? "Pick a date"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start" data-slot="form-date-popover">
        <Calendar mode="single" required={required} selected={day} defaultMonth={day} disabled={outOfBounds(min, max)} autoFocus
          onSelect={(d: Date | undefined) => { onChange(d ? isoDay(d) : ""); setOpenAndBlur(false); }} />
        {!required && value && (
          <div className="flex justify-end border-t pt-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => { onChange(""); setOpenAndBlur(false); }}>Clear</Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad(i * 5));

/** A date and a time as `YYYY-MM-DDTHH:MM`: the date picker, then an hour and a minute select (5-minute
 *  steps, plus the current minute when it is off the step). The time waits for a date; a new date
 *  keeps the time chosen, else takes 00:00. */
export function DateTimePicker({ common, value, onChange, min, max, required }: {
  common: Common; value: string; onChange: (v: string) => void; min?: unknown; max?: unknown; required?: boolean;
}) {
  const date = value.slice(0, 10);
  const t = /T(\d{2}):(\d{2})/.exec(value);
  const hh = t?.[1] ?? "", mm = t?.[2] ?? "";
  const minutes = mm && !MINUTES.includes(mm) ? [...MINUTES, mm].sort() : MINUTES;
  const setTime = (h: string, m: string) => onChange(`${date}T${h || "00"}:${m || "00"}`);
  return (
    <div className="flex items-center gap-1.5" data-slot="form-datetime">
      <DatePicker common={common} value={date} required={required} min={min} max={max} className="min-w-0 flex-1"
        onChange={(d) => onChange(d ? `${d}T${hh || "00"}:${mm || "00"}` : "")} />
      <TimePart label="Hour" slot="form-hour" value={hh} items={HOURS} disabled={!date} onChange={(h) => setTime(h, mm)} />
      <span className="text-muted-foreground" aria-hidden>:</span>
      <TimePart label="Minute" slot="form-minute" value={mm} items={minutes} disabled={!date} onChange={(m) => setTime(hh, m)} />
    </div>
  );
}

function TimePart({ label, slot, value, items, disabled, onChange }: { label: string; slot: string; value: string; items: string[]; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} data-slot={slot} className="text-base tabular-nums md:text-sm"><SelectValue placeholder="--" /></SelectTrigger>
      <SelectContent>{items.map((x) => <SelectItem key={x} value={x} className="tabular-nums">{x}</SelectItem>)}</SelectContent>
    </Select>
  );
}
