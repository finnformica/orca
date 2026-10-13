// Per-browser UI state in localStorage, in one place: versioned keys under `orca.ui.v1.`, a JSON
// read that falls back to the default on anything missing, unparsable or the wrong shape, and a
// write that never throws (a private window, a full bucket). Bump PERSISTED_VERSION when a stored
// shape changes incompatibly — old values are then simply not read. A value that only makes sense
// for one repo (the Agents filters) takes a per-repo key.
import { useCallback, useState } from "react";
import { atomWithStorage } from "jotai/utils";

export const PERSISTED_VERSION = 1;
const PREFIX = `orca.ui.v${PERSISTED_VERSION}.`;

/** `orca.ui.v1.<name>`, or `orca.ui.v1.<name>:<repo>` for a repo-specific value. */
export const persistedKey = (name: string, repo?: string): string => `${PREFIX}${name}${repo ? `:${repo}` : ""}`;

/** The stored value, or `fallback` when absent, unparsable, or rejected by `valid`. `legacyKey` is an
 *  older unversioned key read once when the new one is absent, so a saved choice survives the rename. */
export function readPersisted<T>(key: string, fallback: T, valid?: (v: unknown) => v is T, legacyKey?: string): T {
  const parse = (k: string): { ok: true; v: T } | { ok: false } => {
    try {
      const raw = localStorage.getItem(k);
      if (raw === null) return { ok: false };
      const v: unknown = JSON.parse(raw);
      return valid && !valid(v) ? { ok: false } : { ok: true, v: v as T };
    } catch { return { ok: false }; }
  };
  const got = parse(key);
  if (got.ok) return got.v;
  const old = legacyKey ? parse(legacyKey) : { ok: false as const };
  return old.ok ? old.v : fallback;
}

export function writePersisted<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window / full */ }
}

/** useState backed by localStorage. Changing `key` (e.g. the repo scope) reads that key's value. */
export function usePersisted<T>(key: string, fallback: T, valid?: (v: unknown) => v is T): [T, (v: T) => void] {
  const [state, setState] = useState(() => ({ key, value: readPersisted(key, fallback, valid) }));
  const value = state.key === key ? state.value : readPersisted(key, fallback, valid);
  const set = useCallback((v: T) => { writePersisted(key, v); setState({ key, value: v }); }, [key]);
  return [value, set];
}

/** The same storage for a jotai atom shared across components (the view toggle, density). */
export function persistedAtom<T>(name: string, fallback: T, valid?: (v: unknown) => v is T, legacyKey?: string) {
  return atomWithStorage<T>(persistedKey(name), fallback, {
    getItem: (key, init) => readPersisted(key, init, valid, legacyKey),
    setItem: (key, v) => writePersisted(key, v),
    removeItem: (key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  }, { getOnInit: true });
}

/** A guard for a value that must be one of a fixed set of strings. */
export const oneOf = <T extends string>(...values: readonly T[]) => (v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);

/** A restored choice that no longer exists (a repo dropped from the config, an instance retired)
 *  reads as the default. */
export const validChoice = (value: string, choices: readonly string[], fallback: string): string =>
  value === fallback || choices.includes(value) ? value : fallback;

export const isString = (v: unknown): v is string => typeof v === "string";
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
