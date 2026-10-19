// The agents' slice's real memory limit, for the heavy queue's memory budget (server/heavy.ts).
// Kept out of server/cgroup.ts: that file is Finn's to merge, and this one only reads.
import { readFileSync } from "fs";
import { AGENTS_SLICE, agentsSliceMaxGb } from "./cgroup";

type Env = Record<string, string | undefined>;

/** A cgroup `memory.max` file → GB, floored to one decimal: `max` (no limit) → 0, anything else →
 *  undefined. 11811160064 (what `MemoryMax=11264M` writes) → 11. Pure. */
export function memoryMaxFileGb(text: string): number | undefined {
  const t = text.trim();
  if (t === "max") return 0;
  if (!/^\d+$/.test(t)) return undefined;
  return Math.floor((Number(t) / 1024 ** 3) * 10 + 1e-9) / 10;
}

/** The agents' slice's REAL MemoryMax (GB), read from its cgroup: what the kernel enforces, which
 *  the env value only asks for (the bridge sets it before each launch). 0 = no limit, undefined =
 *  no slice yet (or not Linux). `ORCA_CGROUP_ROOT`: tests. */
export function agentsSliceLimitGb(env: Env = process.env, uid = process.getuid?.() ?? 0): number | undefined {
  const root = `${env.ORCA_CGROUP_ROOT ?? "/sys/fs/cgroup"}/user.slice/user-${uid}.slice/user@${uid}.service/orca.slice/${AGENTS_SLICE}`;
  try { return memoryMaxFileGb(readFileSync(`${root}/memory.max`, "utf8")); } catch { return undefined; }
}

/** The slice limit the heavy queue's memory budget comes from: the real one when the slice has a
 *  limit, else the one the bridge will set (`agentsSliceMaxGb`). */
export function heavySliceGb(env: Env = process.env, uid = process.getuid?.() ?? 0): number {
  return agentsSliceLimitGb(env, uid) || agentsSliceMaxGb(env);
}
