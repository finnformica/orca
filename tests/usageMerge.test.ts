// Usage belongs to the Claude ACCOUNT, not whichever instance the browser happens to be talking to
// — agents run on the cloud box, so a laptop's own stale hydra reading must not be what the meter
// shows. `mergeInstanceProfiles` (server/usage.ts) is the pure merge: every instance's hydra
// profiles, matched by email, the freshest OK reading per account winning; `usageAcrossInstances`
// is the orchestration around it (this host's own `usage()` plus a PEER's `/api/usage/local`, fanned
// out over HTTP, an unreachable peer skipped rather than blocking). The merge is unit-tested direct
// and pure; the orchestration with a fake `hydra` on PATH (the hydraUsage.test.ts PATH-shim pattern)
// standing in for "this host" and a stubbed `fetch` standing in for the peer (the moveWorkstream.test.ts
// pattern) — no second real bridge needed.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeInstanceProfiles, usageAcrossInstances, type InstanceProfiles, type ProfileUsage } from "../server/usage";
import { setProbe } from "../server/peer";

const win = (pct: number) => ({ utilization: pct, resetsAt: null });
const profile = (overrides: Partial<ProfileUsage>): ProfileUsage => ({
  name: "finnformica", email: "finnformica@gmail.com", state: "ok", fetchedAt: 1000,
  usage: { fiveHour: win(10), sevenDay: win(20), extra: null }, ...overrides,
});

test("mergeInstanceProfiles: the freshest OK reading wins across instances, matched by email", () => {
  const byInstance: InstanceProfiles[] = [
    { instance: "local", profiles: [profile({ state: "token stale — refreshes on next launch", usage: null, fetchedAt: 500 })] },
    { instance: "cloud", profiles: [profile({ state: "ok", fetchedAt: 2000 })] },
  ];
  const [merged] = mergeInstanceProfiles(byInstance);
  expect(merged).toMatchObject({ name: "finnformica", state: "ok", instance: "cloud" });
  expect(merged!.usage?.fiveHour.utilization).toBe(10);
  // Every host that reported it is kept, with ITS OWN state — the secondary hint's data.
  expect(merged!.hosts).toEqual([
    { instance: "local", state: "token stale — refreshes on next launch" },
    { instance: "cloud", state: "ok" },
  ]);
});

test("mergeInstanceProfiles: an OLDER ok reading loses to a FRESHER one even from a different instance", () => {
  const byInstance: InstanceProfiles[] = [
    { instance: "local", profiles: [profile({ state: "ok", fetchedAt: 9000 })] },
    { instance: "cloud", profiles: [profile({ state: "ok", fetchedAt: 1000 })] },
  ];
  const [merged] = mergeInstanceProfiles(byInstance);
  expect(merged!.instance).toBe("local"); // local is the fresher ok reading here
  expect(merged!.fetchedAt).toBe(9000);
});

test("mergeInstanceProfiles: with no ok reading anywhere, falls back to the preferred instance (the one that runs agents)", () => {
  const byInstance: InstanceProfiles[] = [
    { instance: "local", profiles: [profile({ state: "token stale — refreshes on next launch", usage: null, fetchedAt: 500 })] },
    { instance: "cloud", profiles: [profile({ state: "exhausted", fetchedAt: 400 })] },
  ];
  const [merged] = mergeInstanceProfiles(byInstance, "cloud");
  expect(merged!.instance).toBe("cloud");
  expect(merged!.state).toBe("exhausted");
  expect(merged!.hosts).toEqual([
    { instance: "local", state: "token stale — refreshes on next launch" },
    { instance: "cloud", state: "exhausted" },
  ]);
});

test("mergeInstanceProfiles: with no ok reading and the preferred instance has nothing usable, falls back to the freshest of whatever is there", () => {
  const byInstance: InstanceProfiles[] = [
    { instance: "local", profiles: [profile({ state: "token stale — refreshes on next launch", usage: null, fetchedAt: 9000 })] },
    { instance: "cloud", profiles: [profile({ state: "not signed in on this machine", usage: null, fetchedAt: 0 })] },
  ];
  const [merged] = mergeInstanceProfiles(byInstance, "cloud"); // preferred, but cloud has no usage reading
  expect(merged!.instance).toBe("local"); // the freshest fetchedAt wins the fallback too
  expect(merged!.state).toBe("token stale — refreshes on next launch");
});

test("mergeInstanceProfiles: a profile with no email (not signed in on this host) stays keyed to its own instance, never merged across hosts", () => {
  const byInstance: InstanceProfiles[] = [
    { instance: "local", profiles: [{ name: "spare", usage: null, state: "not signed in on this machine", fetchedAt: null }] },
    { instance: "cloud", profiles: [{ name: "spare", usage: null, state: "not signed in on this machine", fetchedAt: null }] },
  ];
  const merged = mergeInstanceProfiles(byInstance);
  // Both rows survive separately (no email to match on) rather than silently collapsing into one.
  expect(merged).toHaveLength(2);
  expect(merged.map((p) => p.instance).sort()).toEqual(["cloud", "local"]);
});

test("mergeInstanceProfiles: a single instance's profiles pass through, annotated with their own host", () => {
  const byInstance: InstanceProfiles[] = [{ instance: "local", profiles: [profile({})] }];
  const [merged] = mergeInstanceProfiles(byInstance);
  expect(merged).toMatchObject({ name: "finnformica", state: "ok", instance: "local" });
  expect(merged!.hosts).toEqual([{ instance: "local", state: "ok" }]);
});

test("mergeInstanceProfiles: accounts present on only one instance are kept, order preserved", () => {
  const byInstance: InstanceProfiles[] = [
    { instance: "local", profiles: [profile({ name: "a", email: "a@x", fetchedAt: 1 }), profile({ name: "b", email: "b@x", fetchedAt: 1 })] },
    { instance: "cloud", profiles: [profile({ name: "a", email: "a@x", fetchedAt: 2, state: "ok" })] },
  ];
  const merged = mergeInstanceProfiles(byInstance);
  expect(merged.map((p) => p.name)).toEqual(["a", "b"]); // b only ever reported locally — still shows
  expect(merged.find((p) => p.name === "b")!.hosts).toEqual([{ instance: "local", state: "ok" }]);
});

// ---- usageAcrossInstances: the orchestration (this host's own usage() + a peer over HTTP) ----

let shim: string | undefined;
let prevPath: string | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  setProbe();
  if (prevPath !== undefined) process.env.PATH = prevPath;
  prevPath = undefined;
  if (shim) await rm(shim, { recursive: true, force: true });
  shim = undefined;
});

/** A fake `hydra` first on PATH, same shape as hydraUsage.test.ts's — one login, so `usage()` (this
 *  "local" host's own reading) reports a real profile instead of nothing. */
async function installFakeHydra(state: string, fetchedAt: number): Promise<void> {
  shim = await mkdtemp(join(tmpdir(), "orca-usage-merge-"));
  const doc = { profiles: [{ name: "finnformica", email: "finnformica@gmail.com", signed_in: true, disabled: false, fetched_at: fetchedAt, source: "api", auth: "ok", locked: false, session: { pct: 10, resets: null, severity: "normal" }, weekly: { pct: 20, resets: null, severity: "normal" }, fable: null, state }] };
  await writeFile(join(shim, "status.json"), JSON.stringify(doc));
  await writeFile(join(shim, "hydra"), `#!/bin/sh\ncase "$1 $2" in\n  "status --json") cat "${shim}/status.json" ;;\n  *) exit 1 ;;\nesac\n`);
  await chmod(join(shim, "hydra"), 0o755);
  prevPath = process.env.PATH;
  process.env.PATH = `${shim}:${prevPath}`;
}

test("usageAcrossInstances: a fresher ok reading from the peer wins over this host's own stale one", async () => {
  await installFakeHydra("token stale — refreshes on next launch", 500);
  setProbe(async () => true); // cloud.test is a stubbed fetch, not a host a TCP connect can reach
  globalThis.fetch = (async (url: string | URL | Request) => {
    expect(String(url)).toBe("http://cloud.test/api/usage/local");
    return { ok: true, json: async () => ({ claude: null, codex: null, profiles: [{ name: "finnformica", email: "finnformica@gmail.com", usage: { fiveHour: win(5), sevenDay: win(5), extra: null }, state: "ok", fetchedAt: 9000 }] }) } as unknown as Response;
  }) as typeof fetch;

  const u = await usageAcrossInstances({ cloud: "http://cloud.test" }, "local", "cloud");
  expect(u?.profiles).toHaveLength(1);
  const p = u!.profiles![0]!;
  expect(p.state).toBe("ok");
  expect(p.instance).toBe("cloud");
  expect(p.hosts).toEqual([{ instance: "local", state: "token stale — refreshes on next launch" }, { instance: "cloud", state: "ok" }]);
});

test("usageAcrossInstances: an unreachable peer is skipped, not blocking — this host's own reading still comes back", async () => {
  await installFakeHydra("ok", 1000);
  setProbe(async () => true);
  globalThis.fetch = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;

  const u = await usageAcrossInstances({ cloud: "http://cloud.test" }, "local", "cloud");
  expect(u?.profiles).toHaveLength(1);
  expect(u!.profiles![0]).toMatchObject({ name: "finnformica", state: "ok", instance: "local" });
});

test("usageAcrossInstances: a peer whose connect never completes (a laptop off the tailnet) is not fetched at all", async () => {
  await installFakeHydra("ok", 1000);
  let fetched = 0;
  setProbe(async () => false);
  globalThis.fetch = (async () => { fetched++; return new Promise(() => {}); }) as unknown as typeof fetch; // would hang forever
  const u = await usageAcrossInstances({ cloud: "http://cloud.test" }, "local", "cloud");
  expect(fetched).toBe(0);
  expect(u!.profiles![0]).toMatchObject({ name: "finnformica", instance: "local" });
});

test("usageAcrossInstances: with no `instances` configured at all, behaves exactly like the old single-host reading", async () => {
  await installFakeHydra("ok", 1000);
  const u = await usageAcrossInstances(undefined, "local");
  expect(u?.profiles?.[0]).toMatchObject({ name: "finnformica", state: "ok", instance: "local" });
});
