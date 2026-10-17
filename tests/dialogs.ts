// Drive the in-app confirm (lib/dialogs `confirmDialog`) the way a user would: wait for the
// AlertDialog, read what it asks, press its confirm or Cancel. Returns "<title> — <description>".
import { act } from "react";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const alertDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

export async function answer(ok = true): Promise<string> {
  for (let i = 0; i < 100 && !alertDialog(); i++) await act(async () => { await wait(10); });
  const d = alertDialog();
  if (!d) throw new Error("no confirm dialog opened");
  const text = `${d.querySelector('[data-slot="alert-dialog-title"]')!.textContent} — ${d.querySelector('[data-slot="alert-dialog-description"]')!.textContent}`;
  const button = d.querySelector<HTMLElement>(ok ? '[data-slot="alert-dialog-action"]' : '[data-slot="alert-dialog-cancel"]')!;
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); await wait(0); await wait(0); });
  for (let i = 0; i < 50 && alertDialog(); i++) await act(async () => { await wait(10); });
  return text;
}
