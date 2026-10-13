// An Orca-repo preview's /api: the BRANCH's own bridge in read-only preview mode (ORCA_PREVIEW_BRIDGE=1)
// instead of main's :8787, which made a branch's UI show main's numbers. The bridge never migrates or
// publishes this instance's state; a branch that can't run one forwards to main; the page says which.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import { freePort } from "../server/preview";
import { bridgeLabel } from "../web/src/workstream";
import config from "../orca.config";
import { freshSchema, type TestDb } from "./pg";
import { native } from "./happydom";

let pg: TestDb;
const saved: Record<string, string | undefined> = {};
const ENV = ["ORCA_DATABASE_URL", "ORCA_INSTANCE", "ORCA_PREVIEW_BRIDGE"];
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.ORCA_PREVIEW_BRIDGE;
  pg = await freshSchema("previewbridge");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test("PB1 a preview bridge never applies a migration to the shared database", async () => {
  process.env.ORCA_PREVIEW_BRIDGE = "1";
  await expect(db.open()).rejects.toBeInstanceOf(db.MigrationRefused);
  await db.close();
  delete process.env.ORCA_PREVIEW_BRIDGE;
  await db.open(); // the real bridge migrates it
  await db.close();
  process.env.ORCA_PREVIEW_BRIDGE = "1";
  await db.open(); // up to date: the preview bridge opens it fine
});

test("PB2 a preview bridge publishes none of this instance's state (worktrees, previews, metrics)", async () => {
  process.env.ORCA_INSTANCE = "cloud";
  await db.publishInventory("orca", [{ branch: "feat", data: { agent: "running" } }]);
  await db.publishPreviews([{ key: "/w/feat", data: { svcs: [] } }]);
  process.env.ORCA_PREVIEW_BRIDGE = "1";
  // What the preview bridge would publish: nothing running, no previews — it must not overwrite.
  await db.publishInventory("orca", []);
  await db.publishPreviews([]);
  await db.recordMetric({ cpuPct: 1, load1: 0, memUsedGb: 1, memTotalGb: 2, runningAgents: 0 });
  expect((await db.inventory("orca")).map((r) => [r.branch, r.data.agent])).toEqual([["feat", "running"]]);
  expect((await db.previewInventory()).map((r) => r.key)).toEqual(["/w/feat"]);
  expect(await db.metricHistory("cloud", 1)).toEqual([]);
});

test("PB3 the page names the bridge that answered, and warns when it is main's", () => {
  expect(bridgeLabel({ preview: false, branch: "main", port: 8787 }, false)).toBeNull(); // the real Orca
  expect(bridgeLabel({ preview: true, branch: "orca/x", port: 41234 }, true)).toMatchObject({ text: "API: this branch's bridge (orca/x)", warn: false });
  const main = bridgeLabel({ preview: false, branch: "main", port: 8787 }, true)!;
  expect(main).toMatchObject({ text: "API: main bridge — not this branch", warn: true });
  expect(main.title).toContain(":8787");
  expect(bridgeLabel(undefined, true)!.warn).toBe(true); // an old main without the field: still main
});

test("PB4 the orca repo's preview runs a bridge service and points web's /api at it", () => {
  const orca = config.repos.find((r) => r.name === "orca")!;
  const bridge = orca.previewServices.find((s) => s.name === "bridge")!;
  const web = orca.previewServices.find((s) => s.name === "web")!;
  expect(bridge.command).toContain("scripts/preview-orca.sh' {port}");
  expect(web.command).toContain("ORCA_API_PORT={svc:bridge}");
  expect(web.command).toContain("ORCA_PREVIEW_UI=1");
});

test("PB5 a branch too old for preview mode never starts a bridge: its port forwards to main's", async () => {
  const mainPort = await freePort([41000, 49000]);
  const port = await freePort([41000, 49000]);
  const main = Bun.serve({ port: mainPort, hostname: "127.0.0.1", fetch: (r) => native.Response.json({ from: "main", path: new URL(r.url).pathname + new URL(r.url).search }) });
  const old = mkdtempSync(join(tmpdir(), "orca-oldbranch-")); // no server/db.ts with the preview-mode switch
  const proc = Bun.spawn(["bash", join(import.meta.dir, "..", "scripts", "preview-orca.sh"), String(port)], {
    cwd: old, env: { ...process.env, ORCA_MAIN_API_PORT: String(mainPort) }, stdout: "pipe", stderr: "pipe",
  });
  try {
    let body: unknown;
    for (let i = 0; i < 100 && !body; i++) {
      body = await native.fetch(`http://127.0.0.1:${port}/api/config?x=1`).then((r) => r.json()).catch(() => undefined);
      if (!body) await Bun.sleep(50);
    }
    expect(body).toEqual({ from: "main", path: "/api/config?x=1" });
  } finally {
    proc.kill();
    main.stop(true);
  }
  expect(await new Response(proc.stdout).text()).toContain("predates preview bridges");
});
