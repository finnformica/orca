// Opening the orchestrator, from anywhere — a hook (useOrchestrator), a key, a notification's Open
// (in or out of React) — through ONE function, so every path focuses the composer the same way.
//
// Typing right after opening is the case this exists for. Between the key or click that opens it and
// the composer having focus there is a window — the panel's first mount, a phone's route change — in
// which keystrokes land on <body> and are lost, or (worse) land in the box after a late focus moved
// the caret, so "Sometimes" came out "ometimesS". So: open starts a short TYPEAHEAD capture — printable
// keys typed while focus is not yet in a field are held, in order — and the composer, when it takes
// focus (synchronously, in a layout effect), claims them and appends them where the caret is.
import { getDefaultStore } from "jotai";
import { orchestratorOpenAtom, orchestratorPrefillAtom, orchestratorTabAtom } from "./atoms";
import { isTypingTarget } from "./shortcuts";
import { isNarrow } from "./viewport";
import { navigate } from "./route";

let askSeq = 0;
/** A new ask session: the keystrokes of one ask replace each other in the composer (see ChatComposer). */
export const newAskSession = (): number => ++askSeq;

/** Open the orchestrator and focus its composer, with `text` after its draft. Narrow screens (phones)
 *  NAVIGATE to its routed page (`/orchestrator`); desktop opens the side panel. */
export function openOrchestrator(text = "", session = newAskSession()): void {
  startTypeahead();
  const s = getDefaultStore();
  s.set(orchestratorTabAtom, ""); // the quick-ask pill, O and Ask Orca open the default agent (§7.6)
  if (isNarrow()) navigate("/orchestrator"); else s.set(orchestratorOpenAtom, true);
  s.set(orchestratorPrefillAtom, { text, session, seq: ++askSeq });
}

/** How long a capture waits for the composer to claim it before giving the keys back to the page. */
export const TYPEAHEAD_MS = 1500;
let buffer: string[] | null = null;
let stop: (() => void) | null = null;

/** Begin holding printable keys that arrive while focus is outside any field. Idempotent. */
export function startTypeahead(win: Window = window): void {
  if (buffer) return;
  buffer = [];
  const onKey = (e: KeyboardEvent) => {
    if (!buffer || isTypingTarget(e.target)) return; // a field has focus: the key is its own
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const ch = e.key === "Enter" ? (e.shiftKey ? "\n" : null) : e.key.length === 1 ? e.key : null;
    if (ch === null) return;
    e.preventDefault();
    e.stopPropagation(); // not a shortcut: it is the start of the message
    buffer.push(ch);
  };
  win.addEventListener("keydown", onKey, true);
  const timer = setTimeout(() => endTypeahead(), TYPEAHEAD_MS);
  stop = () => { win.removeEventListener("keydown", onKey, true); clearTimeout(timer); };
}

/** End the capture and hand over what it held (in typing order), or "" if nothing / none running. */
export function endTypeahead(): string {
  const held = buffer?.join("") ?? "";
  stop?.();
  buffer = null; stop = null;
  return held;
}
