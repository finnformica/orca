// scripts/check-native-inputs.ts: every form control in web/src is a shadcn component (Finn's rule).
// The check fails on a raw control or a native picker type, passes a justified case with an
// allow-comment that gives a reason, and finds nothing in the app as it is.
import { describe, expect, test } from "bun:test";
import { findNativeInputs, scan } from "../scripts/check-native-inputs";

const hits = (src: string) => findNativeInputs("x.tsx", src).map((h) => h.what);

describe("check-native-inputs", () => {
  test("a raw <input>, <select>, <textarea> or a createElement of one is a hit", () => {
    expect(hits(`<input value={v} />`)).toEqual(["raw <input>; use the shadcn component in components/ui"]);
    expect(hits(`<select value={v}>`)).toHaveLength(1);
    expect(hits(`  <textarea\n    rows={3} />`)).toHaveLength(1);
    expect(hits(`const t = document.createElement("textarea");`)).toHaveLength(1);
  });

  test("a native picker type is a hit, even on the shadcn Input", () => {
    expect(hits(`<Input type="date" />`)).toEqual([`native "date" input type; use a shadcn picker`]);
    expect(hits(`<Input type={withTime ? "datetime-local" : "text"} />`)).toHaveLength(1);
    for (const t of ["time", "month", "week", "color", "range", "radio", "checkbox", "file"]) expect(hits(`<Input type="${t}" />`)).toHaveLength(1);
  });

  test("the shadcn components, a number Input, comments and a non-type literal are not hits", () => {
    expect(hits(`<Input type="number" />`)).toEqual([]);
    expect(hits(`<Select value={v}><SelectTrigger /></Select>`)).toEqual([]);
    expect(hits(`<Textarea rows={3} />`)).toEqual([]);
    expect(hits(`// a <textarea> wraps its line`)).toEqual([]);
    expect(hits(`<button type="button" role="checkbox" />`)).toEqual([]);
    expect(hits(`const kind = "file";`)).toEqual([]);
  });

  test("an allow-comment with a reason passes its line; one with no reason is a hit", () => {
    expect(hits(`{/* native-input-ok: hidden file input behind a Button */}\n<input type="file" hidden />`)).toEqual([]);
    expect(hits(`<input type="file" hidden /> {/* native-input-ok: behind a Button */}`)).toEqual([]);
    expect(hits(`{/* native-input-ok: */}\n<input type="file" hidden />`)).toEqual([`"native-input-ok:" needs a reason`]);
  });

  test("web/src has no native control outside components/ui", () => {
    expect(scan()).toEqual([]);
  });
});
