// The notification centre's state in the browser: the rows (mirrored from GET /api/notifications,
// pushed to over the tab's one live stream) and the toasts currently showing. Reads are synchronous
// for render; writes go to the bridge and are applied optimistically. Pure decisions — what pops,
// what persists, how the stack is cut — are in shared/notifications.ts.
import { useSyncExternalStore } from "react";
import { getDefaultStore } from "jotai";
import { api } from "../api";
import { subscribeNotifications } from "./events";
import { browserNotifyAtom, notifyDndAtom, orchestratorOpenAtom, toastPrefsAtom } from "./atoms";
import { KIND_META, TOAST_AUTO_HIDE_MS, clockPause, clockResume, clockStart, notificationPath, shouldNotifyBrowser, shouldToast, type HideClock, type Notification, type ToastPrefs } from "../../../shared/notifications";
import { navigate } from "./route";

type State = { list: Notification[]; toasts: Notification[] };
let state: State = { list: [], toasts: [] };
let watermark = 0; // newest createdAt known — the catch-up cursor after a dropped stream
let started = false;
let stop: (() => void) | undefined;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
// Each auto-hiding toast's clock; while the stack is paused (hovered, touched, the tab hidden) they
// all hold what is left, as sonner's do.
const clocks = new Map<number, HideClock>();
let paused = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; notify(); };

/** The auto-hide delay, overridable by tests so a "finished" toast needn't take six seconds to go. */
export const toastTiming = { autoHideMs: TOAST_AUTO_HIDE_MS };

export const useNotifications = (): State =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);

const byNewest = (a: Notification, b: Notification) => b.createdAt - a.createdAt || b.id - a.id;

/** Fold rows into the mirror. `pop`: ones not seen before may toast (never on the first load — those
 *  are for the centre, not the corner). */
function merge(incoming: Notification[], pop: boolean): void {
  const byId = new Map(state.list.map((n) => [n.id, n]));
  const fresh: Notification[] = [];
  for (const n of incoming) {
    if (!byId.has(n.id)) fresh.push(n);
    byId.set(n.id, n);
  }
  const list = [...byId.values()].sort(byNewest);
  for (const n of list) watermark = Math.max(watermark, n.createdAt);
  let toasts = state.toasts;
  if (pop && fresh.length) {
    const store = getDefaultStore();
    const dnd = store.get(notifyDndAtom);
    const prefs = store.get(toastPrefsAtom) as ToastPrefs;
    const add = fresh.filter((n) => shouldToast(n, { dnd, prefs }));
    toasts = [...toasts.filter((t) => !add.some((a) => a.id === t.id)), ...add];
    for (const n of add) if (!KIND_META[n.kind].persistent) scheduleHide(n.id);
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    for (const n of fresh) if (shouldNotifyBrowser(n, { enabled: store.get(browserNotifyAtom), hidden, dnd })) browserNotify(n);
  }
  set({ list, toasts });
}

function scheduleHide(id: number): void {
  clocks.set(id, clockStart(toastTiming.autoHideMs, Date.now(), paused));
  arm(id);
}

/** (Re)arm a toast's timer for what its clock has left; a paused clock has no timer. */
function arm(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const clock = clocks.get(id);
  if (!clock || clock.since === undefined) return;
  timers.set(id, setTimeout(() => { timers.delete(id); dismissToast(id); }, clock.remaining));
}

/** Hold every auto-hide clock (the stack is expanded, touched, or the tab is hidden). */
export function pauseToasts(): void {
  if (paused) return;
  paused = true;
  const now = Date.now();
  for (const [id, c] of clocks) { clocks.set(id, clockPause(c, now)); arm(id); }
}

/** Let the clocks run down again from what each had left. */
export function resumeToasts(): void {
  if (!paused) return;
  paused = false;
  const now = Date.now();
  for (const [id, c] of clocks) { clocks.set(id, clockResume(c, now)); arm(id); }
}

/** Tests: whether the clocks are held. */
export const toastsPaused = (): boolean => paused;

/** A browser notification for an urgent event while the tab is hidden; clicking it brings the tab
 *  back and opens the thing. Silently nothing without the permission. */
function browserNotify(n: Notification): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const note = new Notification(`${KIND_META[n.kind].label} · ${n.title}`, { body: n.body, tag: `orca-${n.id}` });
    note.onclick = () => {
      window.focus();
      const path = notificationPath(n);
      if (n.link?.orchestrator) getDefaultStore().set(orchestratorOpenAtom, true);
      else if (path) navigate(path);
      void markRead([n.id]);
    };
  } catch { /* the platform refused — the centre still has it */ }
}

/** Load the centre (all rows) or catch up from the cursor (rows since it, which may toast). */
export async function hydrate(since?: number): Promise<void> {
  try {
    merge(await api.notifications(since), since !== undefined);
  } catch { /* the next poll or push will */ }
}

/** Start the mirror: load once and hold the tab's live stream for pushes. Idempotent. */
export function start(): void {
  if (started) return;
  started = true;
  void hydrate();
  stop = subscribeNotifications({
    notification: (n) => merge([n], true),
    resync: () => void hydrate(watermark), // the stream was away: anything pushed meanwhile is fetched
  });
}

/** Tests: tear the mirror down so the next mount starts clean. */
export function reset(): void {
  stop?.();
  stop = undefined;
  started = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  clocks.clear();
  paused = false;
  watermark = 0;
  state = { list: [], toasts: [] };
  notify();
}

/** Take a toast off the stack, still unread (it auto-hid): the centre keeps the row as it was. */
export function dismissToast(id: number): void {
  dropToasts([id]);
}

function dropToasts(ids: number[] | "all"): void {
  const hit = (id: number) => ids === "all" || ids.includes(id);
  for (const t of state.toasts) if (hit(t.id)) { clearTimeout(timers.get(t.id)); timers.delete(t.id); clocks.delete(t.id); }
  if (state.toasts.some((t) => hit(t.id))) set({ toasts: state.toasts.filter((t) => !hit(t.id)) });
}

/** Mark read, optimistically; the bridge's row follows. Read is the one state a notification
 *  changes to — the ×, a quick action, opening it and Mark all as read all come here — so its toast
 *  leaves the stack too, and under the centre's Unread filter its row drops out of view. Nothing is
 *  deleted: All still shows it. */
export async function markRead(ids: number[] | "all"): Promise<void> {
  const at = Date.now();
  const hit = (n: Notification) => !n.readAt && (ids === "all" || ids.includes(n.id));
  dropToasts(ids);
  if (state.list.some(hit)) set({ list: state.list.map((n) => (hit(n) ? { ...n, readAt: at } : n)) });
  await api.notificationsRead(ids).catch(() => {});
}
