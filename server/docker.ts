// Thin adapter onto `docker` — for server/preview.ts's reaper, which removes a repo's leftover test
// containers (branch-demo's test harness starts `branch_demo_test_postgres_<port>` Postgres
// containers and never removes them). Mirrors server/gh.ts: shell out, parse, no state of its own.
import { run } from "./run";

export type DockerContainer = { name: string; createdAt: number };

// Docker's `.Created` is RFC3339Nano (up to 9 fractional digits); Date.parse only accepts ≤3.
function parseCreatedAt(s: string): number {
  return Date.parse(s.replace(/(\.\d{3})\d*(Z|[+-]\d{2}:?\d{2})?$/, "$1$2"));
}

/** Running containers whose name contains `prefix`, with their creation time. Empty (never thrown)
 *  when `docker` isn't installed or isn't reachable — a reaper must never fail its whole pass over an
 *  optional tool a given host may not have. */
export async function listContainers(prefix: string): Promise<DockerContainer[]> {
  let names: string[];
  try {
    const out = await run(["docker", "ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"]);
    names = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => {
    const created = (await run(["docker", "inspect", "-f", "{{.Created}}", name])).trim();
    return { name, createdAt: parseCreatedAt(created) };
  }));
}

export async function removeContainer(name: string): Promise<void> {
  await run(["docker", "rm", "-f", name]);
}
