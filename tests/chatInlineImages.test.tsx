// Orca images inline in the chat (Finn 2026-11-03: "is orca not able to display images in the
// chat?"). A worker's `shot: <path>` line, a bare shot path or a markdown image of one was plain
// text everywhere but a report's Screenshots list. Now every chat message body draws them.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import { Markdown } from "@/components/Markdown";
import type { Row } from "@/store";
import { CHAT_IMAGES, SCREENSHOTS, inlineImageParts, orchestratorPrompt, servedImageUrl } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHOT = "/home/orca/.orca/attachments/shots/shot-2026-11-03T10-00-00-000Z-0123abcd-after.png";
const UUID = "0a05639d-3fb8-48f9-8293-eaf92e5b55b8";
const ATT = `/home/orca/.orca/attachments/${UUID}/design.jpg`;

test("servedImageUrl maps only Orca image paths, by id", () => {
  expect(servedImageUrl(SHOT)).toBe("/api/screenshots/shot-2026-11-03T10-00-00-000Z-0123abcd-after");
  expect(servedImageUrl("~/.orca/attachments/shots/shot-x.png")).toBe("/api/screenshots/shot-x");
  expect(servedImageUrl(ATT)).toBe(`/api/attachments/${UUID}`);
  expect(servedImageUrl(`/x/attachments/${UUID.toUpperCase()}/a.PNG`)).toBe(`/api/attachments/${UUID}`);
  // Not an image, not under the attachments dir, not a local path, or a way out of a dir.
  expect(servedImageUrl(`/x/attachments/${UUID}/notes.pdf`)).toBeUndefined();
  expect(servedImageUrl(`/x/attachments/${UUID}/sub/a.png`)).toBeUndefined();
  expect(servedImageUrl("/etc/passwd.png")).toBeUndefined();
  expect(servedImageUrl("/home/u/pics/cat.png")).toBeUndefined();
  expect(servedImageUrl("/x/attachments/shots/../../secret/shot-a.png")).toBeUndefined();
  expect(servedImageUrl("/x/attachments/shots/shot-a.b.png")).toBeUndefined();
  expect(servedImageUrl("https://github.com/o/r/raw/x/attachments/shots/shot-a.png")).toBeUndefined();
  expect(servedImageUrl("attachments/shots/shot-a.png")).toBeUndefined();
  expect(servedImageUrl("/api/screenshots/shot-a")).toBeUndefined();
});

test("inlineImageParts cuts bare Orca paths out of prose and leaves other paths as text", () => {
  expect(inlineImageParts(`shot: ${SHOT}`)).toEqual(["shot: ", { src: "/api/screenshots/shot-2026-11-03T10-00-00-000Z-0123abcd-after", path: SHOT, alt: "after" }]);
  expect(inlineImageParts(`See ${ATT}.`)).toEqual(["See ", { src: `/api/attachments/${UUID}`, path: ATT, alt: "design.jpg" }, "."]);
  expect(inlineImageParts(`(${SHOT})`)[1]).toMatchObject({ path: SHOT });
  expect(inlineImageParts("/home/u/cat.png and /src/a.ts")).toEqual(["/home/u/cat.png and /src/a.ts"]);
  expect(inlineImageParts(`${SHOT}.bak`)).toEqual([`${SHOT}.bak`]);
  expect(inlineImageParts(`https://x.dev${SHOT}`)).toEqual([`https://x.dev${SHOT}`]);
  expect(inlineImageParts(`a${SHOT}`)).toEqual([`a${SHOT}`]);
  const two = inlineImageParts(`- ${SHOT}\n- ~/.orca/attachments/shots/shot-y.png`);
  expect(two.filter((p) => typeof p !== "string")).toHaveLength(2);
});

test("agents are told how to show an image in the chat", () => {
  expect(SCREENSHOTS).toContain(CHAT_IMAGES);
  expect(orchestratorPrompt({ fresh: false, board: "", messages: ["hi"] })).toContain(CHAT_IMAGES);
});

let root: Root | undefined;
let container: HTMLElement | undefined;
const flush = () => new Promise((r) => setTimeout(r, 0));
beforeAll(() => store.configReady);
beforeEach(() => { localStorage.clear(); apiFake.reset(); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  apiFake.reset();
});
async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); await flush(); });
  return container;
}

const body = [
  "Three options:",
  "",
  `![Option A](${SHOT})`,
  "",
  `shot: ${ATT}`,
  "",
  `Kept as text: \`${SHOT}\``,
  "",
  "```",
  `shot: ${SHOT}`,
  "```",
].join("\n");

function expectImages(el: HTMLElement) {
  const imgs = [...el.querySelectorAll("img")];
  expect(imgs.map((i) => new URL(i.getAttribute("src")!, "http://x").pathname)).toEqual([
    "/api/screenshots/shot-2026-11-03T10-00-00-000Z-0123abcd-after",
    `/api/attachments/${UUID}`,
  ]);
  expect(imgs[0]!.getAttribute("alt")).toBe("Option A");
  // The path in backticks and the one in the fence stay text.
  const code = [...el.querySelectorAll("code")].map((c) => c.textContent);
  expect(code.filter((t) => t?.includes(SHOT))).toHaveLength(2);
}

test("a chat reply draws a markdown image and a shot: line inline; code stays text", async () => {
  apiFake.turnsData.set("r::feat", [{ id: "run-1", provider: "claude", prompt: "designs?", response: body, finishedAt: 2 }]);
  const row: Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude" };
  expectImages(await render(<ChatPanel row={row} />));
});

test("the page Markdown draws the same images", async () => {
  expectImages(await render(<Markdown>{body}</Markdown>));
});
