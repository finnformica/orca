// Previews on every instance, from every instance: each bridge publishes its running previews to
// preview_inventory and /api/previews (verbs.previewRows) answers the union from Postgres, the way
// /api/agents does for worktrees. Plus the placement record a stop clears (db.clearPreviewPlacement).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../server/db";
import * as forward from "../server/forward";
import * as preview from "../server/preview";
import { freePort } from "../server/preview";
import { PREVIEW_STALE_MS, previewRows } from "../server/verbs";
import type { OrcaConfig } from "../server/config";
import { freshSchema, type TestDb } from "./pg";

let pg: TestDb;
const saved: Record<string, string | undefined> = {};
const ENV = ["ORCA_DATABASE_URL", "ORCA_INSTANCE", "ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND"];
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.ORCA_PREVIEW_HOST; delete process.env.ORCA_PREVIEW_BIND;
  pg = await freshSchema("previewinv");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
});
afterEach(async () => {
  await db.close();
  await pg.drop();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const cfg = { instances: { laptop: "http://127.0.0.1:8787", cloud: "http://127.0.0.1:8788" } } as unknown as OrcaConfig;
const svc = (port: number) => ({ name: "frontend", port, url: `http://orca-box:${port}`, open: true, running: true, ready: true, startedAt: 1 });

test("each instance lists its own previews live and the others' as published; owner URL kept, localUrl only where forwarded", async () => {
  const port = await freePort([41000, 49000]);
  process.env.ORCA_INSTANCE = "cloud";
  await db.publishPreviews([{ key: "/opt/wt/feat", data: { svcs: [svc(port)] } }]);

  process.env.ORCA_INSTANCE = "laptop";
  const wt = mkdtempSync(join(tmpdir(), "orca-previnv-"));
  await preview.start(wt, wt, [{ name: "web", command: "sleep 30", open: true }], [41000, 49000]);
  try {
    const rows = await previewRows(cfg, { loopback: true });
    const mine = rows.find((r) => r.key === wt)!;
    expect(mine.instance).toBe("laptop");
    const myPort = mine.svcs[0]!.port;
    // Its own: the owner URL from `instances` (no ORCA_PREVIEW_HOST), plus localhost — bound on loopback.
    expect(mine.svcs[0]).toMatchObject({ url: `http://127.0.0.1:${myPort}`, localUrl: `http://localhost:${myPort}` });
    const theirs = rows.find((r) => r.key === "/opt/wt/feat")!;
    expect(theirs.instance).toBe("cloud");
    expect(theirs.svcs[0]).toMatchObject({ url: `http://orca-box:${port}`, localUrl: `http://localhost:${port}` }); // forwarded here

    // What the laptop published carries no localUrl (that names ITS loopback), and did not sweep cloud's row.
    const published = await db.previewInventory();
    expect(published.map((r) => [r.instance, r.key]).sort()).toEqual([["cloud", "/opt/wt/feat"], ["laptop", wt]]);
    expect((published.find((r) => r.instance === "laptop")!.data.svcs as { localUrl?: string }[])[0]!.localUrl).toBeUndefined();

    // A box viewed only over the tailnet holds no forward: the owner URL alone.
    forward.release("/opt/wt/feat");
    process.env.ORCA_INSTANCE = "laptop";
    const remote = (await previewRows(cfg, { loopback: false })).find((r) => r.key === "/opt/wt/feat")!;
    expect(remote.svcs[0]!.localUrl).toBeUndefined();

    // A machine that stopped reporting: its previews are not shown as running.
    const later = (await previewRows(cfg, { loopback: false, now: Date.now() + PREVIEW_STALE_MS + 1000 })).map((r) => r.key);
    expect(later).toEqual([wt]);
  } finally {
    forward.release("/opt/wt/feat");
    preview.stop(wt);
  }
  // Stopped → the next publish sweeps it.
  await previewRows(cfg, { loopback: false });
  expect((await db.previewInventory()).map((r) => r.instance)).toEqual(["cloud"]);
});

test("a stop clears the workstream's recorded placement, found by its key", async () => {
  process.env.ORCA_INSTANCE = "cloud";
  await db.patchEnrichment("r", "feat", { title: "Feat", previewInstance: { instance: "cloud", key: "/opt/wt/feat", startedAt: "2026-10-12T00:00:00Z" } });
  await db.patchEnrichment("r", "other", { previewInstance: { instance: "cloud", key: "/opt/wt/other" } });
  await db.clearPreviewPlacement("/opt/wt/feat");
  const e = await db.enrichment("r");
  expect(e.feat).toEqual({ title: "Feat" });
  expect(e.other?.previewInstance).toEqual({ instance: "cloud", key: "/opt/wt/other" });
});
