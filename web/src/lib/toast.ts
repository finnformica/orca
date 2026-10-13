import { useSyncExternalStore } from "react";
import { actionFailureAsk, actionFailureCopy, type ActionFailure } from "../workstream";

// A tiny toast store: `toast()` from anywhere (store actions, menus, hooks), ONE `Toaster` (App)
// renders the stack. Info dismisses itself; an error stays until you close it — it is the only
// place a failed action's message is shown (the row keeps just the ✗ on its button).
export type Toast = {
  id: number;
  kind: "info" | "error";
  title: string;
  body?: string;
  copy?: string; // what Copy puts on the clipboard; no Copy button without it
  ask?: string;  // what "Ask the orchestrator" prefills; no button without it
};

export const INFO_TOAST_MS = 8000;
let seq = 0;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Show a toast; returns its id. The same toast already showing isn't stacked twice (two views of
 *  one preview both see its crash). */
export function toast(t: Omit<Toast, "id">): number {
  const same = toasts.find((x) => x.kind === t.kind && x.title === t.title && x.body === t.body);
  if (same) return same.id;
  const id = ++seq;
  toasts = [...toasts, { ...t, id }];
  emit();
  if (t.kind === "info") setTimeout(() => dismissToast(id), INFO_TOAST_MS);
  return id;
}

/** A failed action on a workstream: title = action + workstream, body = the message, with Copy (the
 *  message plus repo/branch/PR/action) and Ask the orchestrator (a prefilled hand-off). */
export function actionFailed(f: Omit<ActionFailure, "error">, e: unknown): number {
  const error = e instanceof Error ? e.message : String(e);
  const full = { ...f, error };
  return toast({ kind: "error", title: `${f.action} failed${f.title ? ` · ${f.title}` : ""}`, body: error, copy: actionFailureCopy(full), ask: actionFailureAsk(full) });
}

export function useToasts(): Toast[] {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => toasts);
}

/** Tests: clear the stack between cases. */
export function resetToasts(): void { toasts = []; emit(); }
