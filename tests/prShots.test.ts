// Screenshots in a PR's description (server/prShots.ts): the workstream's reported `orca-shot` PNGs
// are pushed as one orphan commit on pr-assets/<pr>-<slug> through GitHub's git data API and linked
// under the body's `## Screenshots`, which is replaced in place (the rest of the body untouched) and
// left alone when it already shows the same shots. `gh` is a recording PATH shim: every call's args
// and its --input payload are logged, so the exact call sequence is asserted with no network.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncPrShots, uploadPrAssets } from "../server/prShots";
import { prAssetsRef, prShotIds, reportShots, screenshotsSection, shotRefs, withScreenshotsSection, workstreamShots } from "../web/src/workstream";

const SHIM = `#!/bin/sh
echo "$*" >> "$PRSHOTS_LOG"
prev=""; for a in "$@"; do [ "$prev" = "--input" ] && { printf 'INPUT ' >> "$PRSHOTS_LOG"; cat "$a" >> "$PRSHOTS_LOG"; echo >> "$PRSHOTS_LOG"; }
  [ "$prev" = "--body-file" ] && cp "$a" "$PRSHOTS_DIR/edited.md"; prev="$a"; done
case "$*" in
  "pr view"*) cat "$PRSHOTS_DIR/body.json" ;;
  "repo view"*) echo acme/app ;;
  *git/blobs*) n=$(cat "$PRSHOTS_DIR/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$PRSHOTS_DIR/n"; echo "{\\"sha\\":\\"blob$n\\"}" ;;
  *git/trees*) echo '{"sha":"tree1"}' ;;
  *git/commits*) echo '{"sha":"c0ffee"}' ;;
  "api -X PATCH"*) [ -n "$PRSHOTS_NO_REF" ] && { echo "Reference does not exist (HTTP 422)" >&2; exit 1; }; echo '{}' ;;
  "api -X POST repos/{owner}/{repo}/git/refs"*) echo '{}' ;;
  "pr edit"*) exit 0 ;;
  *) echo "shim: unhandled $*" >&2; exit 1 ;;
esac
`;

let dir: string, realPath: string | undefined;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const A = "shot-2026-10-15T10-00-00-000Z-aaaaaaaa-before";
const B = "shot-2026-10-15T11-00-00-000Z-bbbbbbbb-after";
const log = async () => (await readFile(join(dir, "log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
const calls = async () => (await log()).filter((l) => !l.startsWith("INPUT "));
async function shot(id: string, label?: string) {
  const file = join(dir, `${id}.png`);
  await writeFile(file, PNG_BYTES);
  return { id, path: `/home/x/.orca/attachments/shots/${id}.png`, file, ...(label ? { label } : {}) };
}

beforeAll(() => { realPath = process.env.PATH; });
afterAll(() => { process.env.PATH = realPath; });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-prshots-"));
  await writeFile(join(dir, "gh"), SHIM); await chmod(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${realPath}`;
  process.env.PRSHOTS_LOG = join(dir, "log"); process.env.PRSHOTS_DIR = dir;
  await writeFile(join(dir, "body.json"), JSON.stringify({ body: "## Summary\nDoes a thing.\n\n## Test plan\n- run it\n" }));
});
afterEach(async () => {
  delete process.env.PRSHOTS_LOG; delete process.env.PRSHOTS_DIR; delete process.env.PRSHOTS_NO_REF;
  process.env.PATH = realPath;
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
  process.env.PRSHOTS_NO_REF = "1";
  const r = await syncPrShots("/tmp", 42, "orca/update-banner", [await shot(B, "after"), await shot(A, "before")]);
  expect(r).toEqual({ pr: 42, shots: 2, updated: true, ref: "pr-assets/42-update-banner" });
  expect(await calls()).toEqual([
    "pr view 42 --json body",
    "repo view --json nameWithOwner -q .nameWithOwner",
    expect.stringMatching(/^api -X POST repos\/\{owner\}\/\{repo\}\/git\/blobs --input /),
    expect.stringMatching(/^api -X POST repos\/\{owner\}\/\{repo\}\/git\/blobs --input /),
    expect.stringMatching(/^api -X POST repos\/\{owner\}\/\{repo\}\/git\/trees --input /),
    expect.stringMatching(/^api -X POST repos\/\{owner\}\/\{repo\}\/git\/commits --input /),
    expect.stringMatching(/^api -X PATCH repos\/\{owner\}\/\{repo\}\/git\/refs\/heads\/pr-assets\/42-update-banner --input /),
    expect.stringMatching(/^api -X POST repos\/\{owner\}\/\{repo\}\/git\/refs --input /),
    expect.stringMatching(/^pr edit 42 --body-file /),
  ]);
  const inputs = (await log()).filter((l) => l.startsWith("INPUT ")).map((l) => JSON.parse(l.slice(6)));
  expect(inputs[0]).toEqual({ content: Buffer.from(PNG_BYTES).toString("base64"), encoding: "base64" });
  expect(inputs[2]).toEqual({ tree: [
    { path: `${B}.png`, mode: "100644", type: "blob", sha: "blob1" },
    { path: `${A}.png`, mode: "100644", type: "blob", sha: "blob2" },
  ] });
  expect(inputs[3]).toEqual({ message: "PR screenshots (Orca)", tree: "tree1", parents: [] }); // orphan
  expect(inputs[5]).toEqual({ ref: "refs/heads/pr-assets/42-update-banner", sha: "c0ffee" });
  const edited = await readFile(join(dir, "edited.md"), "utf8");
  expect(edited).toBe(`## Summary\nDoes a thing.\n\n## Test plan\n- run it\n\n## Screenshots\n\n<!-- orca:screenshots ${B},${A} -->\n`
    + `![after](https://github.com/acme/app/blob/c0ffee/${B}.png?raw=true)\n![before](https://github.com/acme/app/blob/c0ffee/${A}.png?raw=true)\n`);

  // The PR now shows them: a rerun reads the body and does nothing else.
  await writeFile(join(dir, "body.json"), JSON.stringify({ body: edited }));
  await writeFile(join(dir, "log"), "");
  expect(await syncPrShots("/tmp", 42, "orca/update-banner", [await shot(B, "after"), await shot(A, "before")])).toMatchObject({ updated: false, why: "already up to date" });
  expect(await calls()).toEqual(["pr view 42 --json body"]);
});

test("syncPrShots: at most six, newest first; an existing ref is moved, not created; no shots touches nothing", async () => {
  const many = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => shot(`shot-2026-10-15T1${i}-00-00-000Z-0000000${i}`)));
  expect(await syncPrShots("/tmp", 7, "b", many)).toMatchObject({ shots: 6, updated: true, ref: "pr-assets/7-b" });
  const c = await calls();
  expect(c.filter((l) => l.includes("git/blobs"))).toHaveLength(6);
  expect(c.some((l) => l.startsWith("api -X POST repos/{owner}/{repo}/git/refs"))).toBe(false);
  await writeFile(join(dir, "log"), "");
  expect(await syncPrShots("/tmp", 7, "b", [])).toMatchObject({ shots: 0, updated: false });
  expect(await calls()).toEqual([]);
});

test("uploadPrAssets refuses anything that is not a PNG", async () => {
  await writeFile(join(dir, "notes.png"), "secret text");
  await expect(uploadPrAssets("/tmp", "pr-assets/1-x", [{ name: "notes.png", path: join(dir, "notes.png") }])).rejects.toThrow("not a PNG");
  expect((await calls()).some((l) => l.includes("git/blobs"))).toBe(false);
});
