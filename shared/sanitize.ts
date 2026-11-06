// Postgres refuses U+0000 in `text`/`jsonb` (PostgresError 22P05: "unsupported Unicode escape
// sequence" / "\u0000 cannot be converted to text"), and a worker's own tool output can hold it (a
// `wrangler dev` banner prints "Ready on http://localhost:8790\0"). That byte reaches a step's text,
// a tool's output, a check's output, a worker's report, or any other field built from what a run
// said or ran — so it is stripped here, at the one place every insert of worker-sourced text runs
// through, rather than guarded at each call site.

/** `text` with every U+0000 removed. Pure. */
export const stripNul = (text: string): string => (text.includes("\u0000") ? text.replaceAll("\u0000", "") : text);

/** Every string in a JSON-like value stripped of U+0000 — a step, a tool result, a check, an
 *  enrichment patch. Pure. */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") return stripNul(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripNulDeep(v)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNulDeep(v)])) as T;
  return value;
}
