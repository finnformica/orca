// Settings → Browser notifications: the switch asks for the permission from the click, turns on
// when the browser grants it, and — where the browser refuses (denied, or the plain-http tailnet,
// which is no secure context) or has no API — shows how to allow it instead of a switch that does
// nothing. Before, any answer but "granted" quietly set the switch back off. Also the shadcn
// controls on the page: Do not disturb and Server switcher are Switches named by their Label.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { App } from "@/App";
import { navigate } from "@/lib/route";
import { browserNotifyAtom, notifyDndAtom } from "@/lib/atoms";
import { setBrowserNotify } from "@/lib/notificationStore";
import { browserNotifyChecked, browserNotifyNote, browserPermission } from "../shared/notifications";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => new Promise((r) => setTimeout(r, 0));
const g = globalThis as unknown as { Notification?: unknown; isSecureContext?: boolean };
const realNotification = g.Notification;
const realSecure = g.isSecureContext;

/** A fake Notification API: `answer` is what a prompt resolves to; `callback` is old Safari's form
 *  (the callback, and undefined returned). */
function fakeNotification(permission: string, answer = permission, callback = false) {
  const api = {
    permission,
    asked: 0,
    requestPermission(cb?: (r: string) => void) {
      api.asked++;
      api.permission = answer;
      if (callback) { setTimeout(() => cb?.(answer), 0); return undefined; }
      return Promise.resolve(answer);
    },
  };
  g.Notification = api;
  g.isSecureContext = true;
  return api;
}

describe("pure: what the switch can do", () => {
  test("browserPermission reads the API, the secure context first", () => {
    expect(browserPermission({ isSecureContext: true, Notification: { permission: "granted" } })).toBe("granted");
    expect(browserPermission({ isSecureContext: true, Notification: { permission: "denied" } })).toBe("denied");
    expect(browserPermission({ isSecureContext: true, Notification: { permission: "default" } })).toBe("default");
    expect(browserPermission({ isSecureContext: false, Notification: { permission: "default" } })).toBe("insecure");
    expect(browserPermission({ isSecureContext: true })).toBe("unsupported");
  });
  test("checked only when stored on AND granted; a note only where the switch can't work", () => {
    expect(browserNotifyChecked(true, "granted")).toBe(true);
    expect(browserNotifyChecked(true, "denied")).toBe(false);
    expect(browserNotifyChecked(false, "granted")).toBe(false);
    expect(browserNotifyNote("granted")).toBeNull();
    expect(browserNotifyNote("default")).toBeNull();
    expect(browserNotifyNote("denied")).toMatch(/site settings/);
    expect(browserNotifyNote("insecure")).toMatch(/HTTPS or localhost/);
    expect(browserNotifyNote("unsupported")).toMatch(/Home Screen/);
  });
});

describe("setBrowserNotify", () => {
  afterEach(() => { g.Notification = realNotification; g.isSecureContext = realSecure; getDefaultStore().set(browserNotifyAtom, false); });

  test("default → asks; granted → stored on", async () => {
    const api = fakeNotification("default", "granted");
    expect(await setBrowserNotify(true)).toBe("granted");
    expect(api.asked).toBe(1);
    expect(getDefaultStore().get(browserNotifyAtom)).toBe(true);
    expect(await setBrowserNotify(false)).toBe("granted");
    expect(getDefaultStore().get(browserNotifyAtom)).toBe(false);
  });
  test("old Safari's callback form resolves too (it returned undefined, and .catch threw)", async () => {
    fakeNotification("default", "granted", true);
    expect(await setBrowserNotify(true)).toBe("granted");
    expect(getDefaultStore().get(browserNotifyAtom)).toBe(true);
  });
  test("refused at the prompt, already denied or insecure → stays off; denied is never asked again", async () => {
    fakeNotification("default", "denied");
    expect(await setBrowserNotify(true)).toBe("denied");
    expect(getDefaultStore().get(browserNotifyAtom)).toBe(false);
    const api = fakeNotification("denied");
    expect(await setBrowserNotify(true)).toBe("denied");
    expect(api.asked).toBe(0);
    fakeNotification("default");
    g.isSecureContext = false;
    expect(await setBrowserNotify(true)).toBe("insecure");
    expect(getDefaultStore().get(browserNotifyAtom)).toBe(false);
  });
});

describe("Settings page", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel);
  async function open() {
    navigate("/settings");
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container!); root.render(<App />); await flush(); });
    await act(async () => { await store.refresh(); await flush(); });
  }
  beforeAll(() => store.configReady);
  beforeEach(() => apiFake.reset());
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = container = undefined;
    g.Notification = realNotification; g.isSecureContext = realSecure;
    getDefaultStore().set(browserNotifyAtom, false);
    getDefaultStore().set(notifyDndAtom, false);
  });

  test("the switch asks from the click and turns on when granted", async () => {
    const api = fakeNotification("default", "granted");
    await open();
    const sw = () => $('[data-slot="browser-notify"]')!;
    expect(sw().getAttribute("role")).toBe("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect($('[data-slot="browser-notify-note"]')).toBeNull();
    await act(async () => { sw().click(); await flush(); await flush(); });
    expect(api.asked).toBe(1);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(getDefaultStore().get(browserNotifyAtom)).toBe(true);
  });

  test("denied: a note says how to allow it, no switch; allowed later, the switch is back on focus", async () => {
    const api = fakeNotification("denied");
    getDefaultStore().set(browserNotifyAtom, true); // a stored "on" from before the block
    await open();
    expect($('[data-slot="browser-notify"]')).toBeNull();
    expect($('[data-slot="browser-notify-note"]')!.textContent).toMatch(/site settings/);
    api.permission = "granted";
    await act(async () => { window.dispatchEvent(new Event("focus")); await flush(); });
    expect($('[data-slot="browser-notify-note"]')).toBeNull();
    expect($('[data-slot="browser-notify"]')!.getAttribute("aria-checked")).toBe("true");
  });

  test("insecure (the http tailnet): a note, no switch", async () => {
    fakeNotification("default");
    g.isSecureContext = false;
    await open();
    expect($('[data-slot="browser-notify"]')).toBeNull();
    expect($('[data-slot="browser-notify-note"]')!.textContent).toMatch(/HTTPS or localhost/);
  });

  test("Do not disturb is a Switch its Label works; the toast kinds are Checkboxes on the first text line", async () => {
    fakeNotification("granted");
    await open();
    const dnd = $("#setting-dnd")!;
    expect(dnd.getAttribute("role")).toBe("switch");
    await act(async () => { $('label[for="setting-dnd"]')!.click(); await flush(); });
    expect(getDefaultStore().get(notifyDndAtom)).toBe(true);
    expect(dnd.getAttribute("aria-checked")).toBe("true");
    const row = $('[data-slot="notification-kinds"] li')!;
    expect(row.className).toMatch(/\bitems-start\b/);
    expect(row.querySelector('[role="checkbox"]')!.className).toMatch(/\bmt-0\.5\b/);
    expect(row.querySelector("label")!.className).toMatch(/\bleading-5\b/);
    expect(document.querySelector('[data-slot="settings-notifications"] input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('#setting-server-switcher')!.getAttribute("role")).toBe("switch");
  });
});
