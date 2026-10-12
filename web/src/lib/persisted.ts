// Persisted per-browser UI state — the ONE helper for it. Keys are versioned under `orca.ui.`
// (`orca.ui.<name>.v<version>`), so a change of shape bumps the version instead of misreading an old
// value. A read never throws: bad JSON, a value of the wrong type (or one `valid` rejects), a
// private window — all fall back to the default. A value that is per-repo goes under a per-repo
// name (`perRepo`). A jotai atom, so a key, a button and the palette that touch
// the same state share one atom (and other tabs see the change through the `storage` event).
import { atom, useAtom, type WritableAtom } from "jotai";

export const UI_PREFIX = "orca.ui.";
export const uiKey = (name: string, version = 1) => `${UI_PREFIX}${name}.v${version}`;
/** A per-repo name for a value that only means something in one repo. */
export const perRepo = (name: string, repo: string) => `${name}:${repo}`;

type Opts<T> = { version?: number; valid?: (v: unknown) => v is T; legacyKey?: string };

// Same JSON type as the default (an array for an array) — the cheap guard that keeps a hand-edited
// or stale value from reaching a component that expects, say, a string.
const sameType = (v: unknown, d: unknown) => Array.isArray(d) ? Array.isArray(v) : v !== null && typeof v === typeof d;

const parse = (raw: string | null): { ok: boolean; value?: unknown } => {
  if (raw === null) return { ok: false };
  try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false }; }
};

/** The stored value at `key`, or `fallback` when it is absent, unparsable or the wrong shape.
 *  `legacyKey` is read once when the versioned key has nothing yet (the pre-`orca.ui.` keys). */
export function readPersisted<T>(key: string, fallback: T, opts: Omit<Opts<T>, "version"> = {}): T {
  const ok = (v: unknown): v is T => sameType(v, fallback) && (!opts.valid || opts.valid(v));
  try {
    const cur = parse(localStorage.getItem(key));
    if (cur.ok) return ok(cur.value) ? cur.value : fallback;
    if (opts.legacyKey) {
      const old = parse(localStorage.getItem(opts.legacyKey));
      if (old.ok && ok(old.value)) return old.value;
    }
  } catch { /* storage unavailable */ }
  return fallback;
}

export function writePersisted<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window / full */ }
}

export type PersistedAtom<T> = WritableAtom<T, [T | ((prev: T) => T)], void>;

/** A jotai atom persisted under `uiKey(name, version)`. It reads localStorage on first use in a store
 *  (a page load), writes through on every set, and follows other tabs' writes while mounted. */
export function persistedAtom<T>(name: string, fallback: T, opts: Opts<T> = {}): PersistedAtom<T> {
  const key = uiKey(name, opts.version);
  const read = () => readPersisted(key, fallback, opts);
  const set = atom<{ v: T } | null>(null); // null until this store sets it: the stored value stands
  set.onMount = (setSet) => {
    const on = (e: StorageEvent) => { if (e.key === key) setSet({ v: read() }); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  };
  const a: PersistedAtom<T> = atom(
    (get) => { const s = get(set); return s ? s.v : read(); },
    (get, put, update: T | ((prev: T) => T)) => {
      const v = typeof update === "function" ? (update as (prev: T) => T)(get(a)) : update;
      put(set, { v });
      writePersisted(key, v);
    },
  );
  return a;
}

// One atom per key, so every `usePersisted` of a key shares its state.
const atoms = new Map<string, PersistedAtom<unknown>>();
/** `useState`, persisted: `const [v, setV] = usePersisted("thing", default)`. */
export function usePersisted<T>(name: string, fallback: T, opts: Opts<T> = {}) {
  const key = uiKey(name, opts.version);
  let a = atoms.get(key) as PersistedAtom<T> | undefined;
  if (!a) { a = persistedAtom(name, fallback, opts); atoms.set(key, a as PersistedAtom<unknown>); }
  return useAtom(a);
}

/** A restored choice that no longer exists (a repo dropped from the config, an instance retired)
 *  reads as the default. */
export const validChoice = (value: string, choices: readonly string[], fallback: string): string =>
  value === fallback || choices.includes(value) ? value : fallback;
