// A repo's check gate (`check: "local" | "github"`, server/ciGate.ts) is set from Settings' Repos
// rows. Server: the setter changes that one key and keeps the rest of the document. UI (the fake
// api, a real DOM): each repo with a remote has a Box | GitHub CI control that calls the route.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as db from "../server/db";
import { invalidateConfig, loadConfig, parseConfigDocument, saveConfigDocument, setInstanceTerminal, setRepoCheck } from "../server/config";
import { freshSchema } from "./pg";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";

test("RC1: the setter sets github, local removes the key, and the rest of the document stays", async () => {
  const doc = {
    repos: [
      { name: "app", repoPath: "/tmp/app", worktreeRoot: "/tmp/app/.worktrees", baseBranch: "main", checkCommand: "bun run check" },
      { name: "site", repoPath: "/tmp/site", worktreeRoot: "/tmp/site/.worktrees", baseBranch: "main" },
    ],
    portRange: [30000, 40000], staleHours: 24,
  };
  const prev = process.env.ORCA_DATABASE_URL;
  const pg = await freshSchema("repocheck");
  process.env.ORCA_DATABASE_URL = pg.url;
  await db.close();
  invalidateConfig();
  try {
    await saveConfigDocument(parseConfigDocument(doc).config!);
    await setInstanceTerminal("box", true);
    await setRepoCheck("app", "github");
    invalidateConfig();
    let cfg = await loadConfig();
    expect(cfg.repos.find((r) => r.name === "app")).toMatchObject({ check: "github", checkCommand: "bun run check" });
    expect(cfg.repos.find((r) => r.name === "site")!.check).toBeUndefined();
    expect(cfg.terminal).toEqual({ box: true });
    await setRepoCheck("app", "local");
    invalidateConfig();
    cfg = await loadConfig();
    expect(cfg.repos.find((r) => r.name === "app")!.check).toBeUndefined();
    await expect(setRepoCheck("nope", "github")).rejects.toThrow('no repo named "nope"');
  } finally {
    await db.close();
    await pg.drop();
    if (prev === undefined) delete process.env.ORCA_DATABASE_URL; else process.env.ORCA_DATABASE_URL = prev;
    invalidateConfig();
  }
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
let root: Root | undefined;
let container: HTMLElement | undefined;

beforeAll(() => store.configReady);
afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
  await store.setRepoCheck("r", "local"); // one bun process: leave the config mirror as other files expect it
  apiFake.reset();
  navigate("/");
});

test("RC2: Settings' Repos row switches the repo's check gate to GitHub CI and back", async () => {
  apiFake.repoHasRemote = true;
  navigate("/settings");
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
  await act(async () => { await store.refresh(); await flush(); await flush(); });
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-slot="repo-check"] button')];
  const pressed = () => buttons().find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;
  expect(buttons().map((b) => b.textContent)).toEqual(["Box", "GitHub CI"]);
  expect(pressed()).toBe("Box");
  await act(async () => { buttons()[1]!.click(); await flush(); await flush(); });
  expect(apiFake.setRepoCheckCalls).toEqual([{ repo: "r", check: "github" }]);
  expect(pressed()).toBe("GitHub CI");
  // The control does not open the repo's Agents list (the row's own button does).
  expect(location.pathname).toBe("/settings");
  await act(async () => { buttons()[0]!.click(); await flush(); await flush(); });
  expect(apiFake.setRepoCheckCalls).toEqual([{ repo: "r", check: "github" }, { repo: "r", check: "local" }]);
});
