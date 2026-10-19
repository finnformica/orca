// The labels of the catch-all links ("All channels and DMs"), read once from /api/integrations, so the
// chat's activity rows can drop one stored as a message's place (`shownPlace`). One read per page
// load and per Refresh everything — not a poll: links change only in Settings. A failed read leaves
// the set empty, which shows the stored place as before.
import { useSyncExternalStore } from "react";
import { api } from "../api";
import { onRefresh } from "./refresh";
import { catchAllLabels } from "../../../shared/integrations";

let labels: ReadonlySet<string> = new Set();
let loaded: Promise<void> | undefined;
const subs = new Set<() => void>();

/** Read the links again (Refresh everything, and tests). */
export function reloadCatchAllLabels(): Promise<void> {
  loaded = api.integrations().then(
    (d) => { labels = catchAllLabels(d.links ?? []); subs.forEach((s) => s()); },
    () => {},
  );
  return loaded;
}

onRefresh(reloadCatchAllLabels);

const subscribe = (fn: () => void) => {
  subs.add(fn);
  if (!loaded) void reloadCatchAllLabels();
  return () => { subs.delete(fn); };
};

/** The catch-all links' labels; empty until the first read lands. */
export const useCatchAllLabels = (): ReadonlySet<string> => useSyncExternalStore(subscribe, () => labels, () => labels);
