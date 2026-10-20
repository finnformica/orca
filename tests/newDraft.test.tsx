// E2E for the New-draft box (views/NewDraft.tsx), the composer in the sidebar's Add New dialog.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as store from "@/store";
import { NewDraft } from "@/views/NewDraft";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => store.configReady); // cfg (repo "r") populated before the first render

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(<NewDraft />); await flush(); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("new-draft box", () => {
  test("the composer asks for a feature", async () => {
    await mount();
    expect(container!.querySelector('textarea[placeholder^="Describe a feature"]')).not.toBeNull();
  });

  test("the box has no instance ('Run on') picker — drafts always start local, moved to cloud from the card instead", async () => {
    await mount();
    expect(container!.querySelector('[aria-label="Run on"]')).toBeNull();
  });
});
