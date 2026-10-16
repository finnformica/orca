// Screenshots in a PR's description (server/prShots.ts): the workstream's reported `orca-shot` PNGs
// are pushed as one orphan commit on pr-assets/<pr>-<slug> through GitHub's git data API and linked
// under the body's `## Screenshots`, which is replaced in place (the rest of the body untouched) and
// left alone when it already shows the same shots. GitHub is a recording fake fetch
// (server/github.ts `setFetch`): every call's method, path and JSON payload are kept, so the exact
// call sequence is asserted with no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPrShots, uploadPrAssets } from "../server/prShots";
import { resetCaches, setFetch } from "../server/github";
import { prAssetsRef, prShotIds, reportShots, screenshotsSection, shotRefs, withScreenshotsSection, workstreamShots } from "../web/src/workstream";
import { native } from "./happydom";

let dir: string;
let calls_: Array<{ call: string; input?: any }> = [];
let prBody = "";
let noRef = false;
let blobs = 0;
const reply = (body: unknown, status = 200) => new native.Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  const method = init?.method ?? "GET";
  const input = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls_.push({ call: `${method} ${path}`, input });
  if (method === "GET" && /\/pulls\/\d+$/.test(path)) return reply({ body: prBody });
  if (method === "PATCH" && /\/pulls\/\d+$/.test(path)) { prBody = input.body; return reply({}); }
  if (/git\/blobs$/.test(path)) return reply({ sha: `blob${++blobs}` }, 201);
  if (/git\/trees$/.test(path)) return reply({ sha: "tree1" }, 201);
  if (/git\/commits$/.test(path)) return reply({ sha: "c0ffee" }, 201);
  if (method === "PATCH" && /git\/refs\//.test(path)) return noRef ? reply({ message: "Reference does not exist" }, 422) : reply({});
  if (method === "POST" && /git\/refs$/.test(path)) return reply({}, 201);
  return reply({ message: `unhandled ${method} ${path}` }, 404);
};
const calls = async () => calls_.map((c) => c.call);
async function shot(id: string, label?: string) {
  const file = join(dir, `${id}.png`);
  await writeFile(file, PNG_BYTES);
  return { id, path: `/home/x/.orca/attachments/shots/${id}.png`, file, ...(label ? { label } : {}) };
}
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const A = "shot-2026-10-15T10-00-00-000Z-aaaaaaaa-before";
const B = "shot-2026-10-15T11-00-00-000Z-bbbbbbbb-after";

let prevToken: string | undefined, prevRepo: string | undefined, prevApi: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-prshots-"));
  calls_ = []; noRef = false; blobs = 0;
  prBody = "## Summary\nDoes a thing.\n\n## Test plan\n- run it\n";
  prevToken = process.env.GH_TOKEN; prevRepo = process.env.ORCA_GITHUB_REPO; prevApi = process.env.ORCA_GITHUB_API_URL;
  process.env.GH_TOKEN = "tok-test"; process.env.ORCA_GITHUB_REPO = "acme/app"; process.env.ORCA_GITHUB_API_URL = "https://api.github.test";
  resetCaches();
  setFetch(fakeFetch as never);
});
afterEach(async () => {
  setFetch(undefined);
  resetCaches();
  for (const [k, v] of [["GH_TOKEN", prevToken], ["ORCA_GITHUB_REPO", prevRepo], ["ORCA_GITHUB_API_URL", prevApi]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
});

test("withScreenshotsSection: appended once, replaced in place, removed when empty — the rest untouched, idempotent", () => {
  const body = "## Summary\nDoes a thing.\n\n## Test plan\n- run it\n";
  const one = screenshotsSection([{ id: A, url: "https://x/a.png", alt: "before" }]);
  const two = screenshotsSection([{ id: B, url: "https://x/b.png", alt: "after" }, { id: A, url: "https://x/a.png", alt: "before" }]);
  const added = withScreenshotsSection(body, one);
  expect(added).toBe(`${body.trimEnd()}\n\n${one}\n`);
  expect(withScreenshotsSection(added, one)).toBe(added); // idempotent
  expect(prShotIds(added)).toEqual([A]);
  // In the middle of a body: only that section changes.
  const middle = "## Summary\nx\n\n## Screenshots\n\nold stuff\n![o](u)\n\n## Test plan\n- y\n";
  const replaced = withScreenshotsSection(middle, two);
  expect(replaced).toBe(`## Summary\nx\n\n${two}\n\n## Test plan\n- y\n`);
  expect(withScreenshotsSection(replaced, two)).toBe(replaced);
  expect(prShotIds(replaced)).toEqual([B, A]);
  expect(withScreenshotsSection(replaced, "")).toBe("## Summary\nx\n\n## Test plan\n- y\n");
  expect(withScreenshotsSection("", one)).toBe(`${one}\n`);
  expect(prShotIds(body)).toEqual([]);
});

test("shotRefs / workstreamShots / reportShots: label and time from the file name; newest turn first, a shot once", () => {
  expect(shotRefs(`shot: /s/.orca/attachments/shots/${B}.png and again /s/.orca/attachments/shots/${B}.png`))
    .toEqual([{ id: B, path: `/s/.orca/attachments/shots/${B}.png`, label: "after", at: Date.parse("2026-10-15T11:00:00.000Z") }]);
  expect(shotRefs("/x/shots/shot-2026-10-15T11-00-00-000Z-cccccccc.png")[0]!.label).toBeUndefined();
  const turns = [
    { id: "r1", response: `before: /h/.orca/attachments/shots/${A}.png`, startedAt: 1, finishedAt: 2 },
    { id: "r2", response: "no shots", startedAt: 3 },
    { id: "r3", response: `done`, structured: { outcome: "", verification: [`/h/.orca/attachments/shots/${A}.png`, `/h/.orca/attachments/shots/${B}.png`] } as never, startedAt: 4, finishedAt: 5 },
  ];
  expect(workstreamShots(turns).map((g) => [g.runId, g.at, g.shots.map((s) => s.id)])).toEqual([["r3", 5, [B, A]]]);
  const body = `Outcome: ok\nScreenshots (Read to view):\n- after: /h/.orca/attachments/shots/${B}.png\nFull turn: orca read --run r3`;
  expect(reportShots(body)).toEqual({ text: "Outcome: ok\nFull turn: orca read --run r3", shots: shotRefs(body) });
  expect(prAssetsRef(42, "orca/Update-banner_x")).toBe("pr-assets/42-update-banner-x");
});

test("syncPrShots: blobs → tree → orphan commit → ref (created when missing) → the body's Screenshots section", async () => {
  noRef = true;
  const r = await syncPrShots("/tmp", 42, "orca/update-banner", [await shot(B, "after"), await shot(A, "before")]);
  expect(r).toEqual({ pr: 42, shots: 2, updated: true, ref: "pr-assets/42-update-banner" });
  expect(await calls()).toEqual([
    "GET /repos/acme/app/pulls/42",
    "POST /repos/acme/app/git/blobs",
    "POST /repos/acme/app/git/blobs",
    "POST /repos/acme/app/git/trees",
    "POST /repos/acme/app/git/commits",
    "PATCH /repos/acme/app/git/refs/heads/pr-assets/42-update-banner",
    "POST /repos/acme/app/git/refs",
    "PATCH /repos/acme/app/pulls/42",
  ]);
  const inputs = calls_.filter((c) => c.input).map((c) => c.input);
  expect(inputs[0]).toEqual({ content: Buffer.from(PNG_BYTES).toString("base64"), encoding: "base64" });
  expect(inputs[2]).toEqual({ tree: [
    { path: `${B}.png`, mode: "100644", type: "blob", sha: "blob1" },
    { path: `${A}.png`, mode: "100644", type: "blob", sha: "blob2" },
  ] });
  expect(inputs[3]).toEqual({ message: "PR screenshots (Orca)", tree: "tree1", parents: [] }); // orphan
  expect(inputs[5]).toEqual({ ref: "refs/heads/pr-assets/42-update-banner", sha: "c0ffee" });
  const edited = prBody;
  expect(edited).toBe(`## Summary\nDoes a thing.\n\n## Test plan\n- run it\n\n## Screenshots\n\n<!-- orca:screenshots ${B},${A} -->\n`
    + `![after](https://github.com/acme/app/blob/c0ffee/${B}.png?raw=true)\n![before](https://github.com/acme/app/blob/c0ffee/${A}.png?raw=true)\n`);

  // The PR now shows them: a rerun reads the body and does nothing else.
  calls_ = [];
  expect(await syncPrShots("/tmp", 42, "orca/update-banner", [await shot(B, "after"), await shot(A, "before")])).toMatchObject({ updated: false, why: "already up to date" });
  expect(await calls()).toEqual(["GET /repos/acme/app/pulls/42"]);
});

test("syncPrShots: at most six, newest first; an existing ref is moved, not created; no shots touches nothing", async () => {
  const many = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => shot(`shot-2026-10-15T1${i}-00-00-000Z-0000000${i}`)));
  expect(await syncPrShots("/tmp", 7, "b", many)).toMatchObject({ shots: 6, updated: true, ref: "pr-assets/7-b" });
  const c = await calls();
  expect(c.filter((l) => l.includes("git/blobs"))).toHaveLength(6);
  expect(c.includes("POST /repos/acme/app/git/refs")).toBe(false);
  calls_ = [];
  expect(await syncPrShots("/tmp", 7, "b", [])).toMatchObject({ shots: 0, updated: false });
  expect(await calls()).toEqual([]);
});

test("uploadPrAssets refuses anything that is not a PNG", async () => {
  await writeFile(join(dir, "notes.png"), "secret text");
  await expect(uploadPrAssets("/tmp", "pr-assets/1-x", [{ name: "notes.png", path: join(dir, "notes.png") }])).rejects.toThrow("not a PNG");
  expect((await calls()).some((l) => l.includes("git/blobs"))).toBe(false);
});
