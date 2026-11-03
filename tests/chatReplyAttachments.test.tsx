// An agent reply carries the files it names, like a user message carries its uploads (Finn
// 2026-11-03: "given i can send images and attachments to you, it should be fairly simple to allow
// the reverse"). A `shot: <path>` line, a bare path or a markdown image of a file under the Orca
// attachments dir becomes one of the reply's `replyAttachments` (set by /api/turns: see
// attachmentsRelay.test.ts), drawn by the SAME Attachments / ComposerAttachment chips as the user's.
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { ChatPanel } from "@/views/Chat";
import type { Row } from "@/store";
import { CHAT_IMAGES, SCREENSHOTS, orcaFile, orchestratorPrompt, replyAttachments, withoutCode } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHOT_ID = "shot-2026-11-03T10-00-00-000Z-0123abcd-after";
const SHOT = `/home/orca/.orca/attachments/shots/${SHOT_ID}.png`;
const UUID = "0a05639d-3fb8-48f9-8293-eaf92e5b55b8";
const ATT = `/home/orca/.orca/attachments/${UUID}/design.jpg`;
const PDF = `/home/orca/.orca/attachments/${UUID.replace("0a", "1b")}/invoice.pdf`;
const shotRef = { id: SHOT_ID, name: `${SHOT_ID}.png`, url: `/api/screenshots/${SHOT_ID}` };

test("orcaFile accepts only files under the attachments dir, by id", () => {
  expect(orcaFile(SHOT)).toEqual(shotRef);
  expect(orcaFile("~/.orca/attachments/shots/shot-x.png")).toEqual({ id: "shot-x", name: "shot-x.png", url: "/api/screenshots/shot-x" });
  expect(orcaFile(ATT)).toEqual({ id: UUID, name: "design.jpg" });
  expect(orcaFile(PDF)).toMatchObject({ name: "invoice.pdf" });
  expect(orcaFile(`/x/attachments/${UUID.toUpperCase()}/a.PNG`)).toEqual({ id: UUID, name: "a.PNG" });
  // Outside the dir, a sub-dir, a way out, a URL, a relative path, or a served route.
  for (const p of [
    `/x/attachments/${UUID}/sub/a.png`, "/etc/passwd", "/home/u/pics/cat.png", "/tmp/shots/shot-a.png",
    "/x/attachments/shots/../../secret/shot-a.png", `/x/attachments/${UUID}/../../etc/passwd`, "/x//attachments/shots/shot-a.png",
    "/x/attachments/shots/shot-a.b.png", "https://github.com/o/r/raw/x/attachments/shots/shot-a.png",
    "attachments/shots/shot-a.png", "/api/screenshots/shot-a",
  ]) expect(orcaFile(p)).toBeUndefined();
});

test("withoutCode drops fences and code spans", () => {
  expect(withoutCode("a `x` b ``y ` z`` c")).toBe("a  b  c");
  expect(withoutCode("before\n```bash\nshot: /p\n```\nafter")).toBe("before\n\nafter");
  expect(withoutCode("before\n~~~\nopen fence")).toBe("before\n");
});

test("replyAttachments finds named files outside code, in order, each once", () => {
  const reply = [
    "Three options:", `![Option A](${SHOT})`, `shot: ${ATT}.`, `See (${PDF}), and ${SHOT} again.`,
    `Kept as text: \`shot: ${SHOT.replace("after", "before")}\``, "```", `shot: ${SHOT.replace("after", "code")}`, "```",
    "/home/u/cat.png, https://x.dev/attachments/shots/shot-y.png",
  ].join("\n");
  expect(replyAttachments(reply)).toEqual([shotRef, { id: UUID, name: "design.jpg" }, { id: UUID.replace("0a", "1b"), name: "invoice.pdf" }]);
  expect(replyAttachments("nothing here")).toEqual([]);
});

test("agents are told how to show a file in the chat", () => {
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

test("a reply's files render as the user's attachment chips; its markdown image becomes its alt text", async () => {
  const response = [`![Option A](${SHOT})`, "", `shot: ${ATT}`, "", `Kept as text: \`${SHOT}\``].join("\n");
  apiFake.turnsData.set("r::feat", [{
    id: "run-1", provider: "claude", prompt: "designs?", response, finishedAt: 2,
    replyAttachments: [shotRef, { id: UUID, name: "design.jpg" }, { id: "1b05639d-3fb8-48f9-8293-eaf92e5b55b8", name: "invoice.pdf" }],
  }]);
  const row: Row = { repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "", lane: "LOCAL", worktreePath: "/wt/feat", agentProvider: "claude" };
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<ChatPanel row={row} />); await flush(); await flush(); });

  const box = container.querySelector("[data-slot=message-attachments]")!;
  expect(box).toBeTruthy();
  const imgs = [...box.querySelectorAll("[data-slot=attachment-image] img")].map((i) => new URL(i.getAttribute("src")!, "http://x").pathname);
  expect(imgs).toEqual([`/api/screenshots/${SHOT_ID}`, `/api/attachments/${UUID}`]);
  const file = box.querySelector<HTMLAnchorElement>("[data-slot=attachment-file]")!;
  expect(file.textContent).toBe("invoice.pdf");
  expect(new URL(file.href).pathname).toBe("/api/attachments/1b05639d-3fb8-48f9-8293-eaf92e5b55b8");
  // No broken inline image: the markdown image is its alt text, and the code span stays text.
  expect(container.querySelectorAll("img").length).toBe(2);
  expect(container.textContent).toContain("Option A");
  expect([...container.querySelectorAll("code")].some((c) => c.textContent === SHOT)).toBe(true);
});
