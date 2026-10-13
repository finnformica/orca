// The page's side of the service worker (web/sw.template.js → dist/sw.js). Registered only from a
// production build (a build id that isn't "dev") and only where the browser allows one — a secure
// context: localhost or HTTPS, so over the plain-http tailnet it stays inert until that has TLS.
// A new build's worker installs and waits; `applyUpdate` (the new-build banner's Refresh) tells it to
// take over and reloads once it controls the page, so the reload gets the new shell, not the old one.

type Nav = { serviceWorker?: ServiceWorkerContainer };

export function registerServiceWorker(build: string | undefined, win: Window = window): void {
  if (!build || build === "dev" || !win.isSecureContext || !("serviceWorker" in win.navigator)) return;
  win.addEventListener("load", () => { void win.navigator.serviceWorker.register("/sw.js").catch(() => {}); }, { once: true });
}

/** Activate the newer build: ask the deployed worker to install if it hasn't yet, wait (briefly) for
 *  it, tell it to skip waiting, and reload when it takes control. With no worker, a plain reload. */
export async function applyUpdate(nav: Nav = navigator, reload: () => void = () => location.reload(), waitMs = 5000): Promise<void> {
  const reg = await nav.serviceWorker?.getRegistration().catch(() => undefined);
  if (!reg) return reload();
  if (!reg.waiting) {
    await reg.update().catch(() => {});
    for (let t = 0; !reg.waiting && t < waitMs; t += 100) await new Promise((r) => setTimeout(r, 100));
  }
  const waiting = reg.waiting;
  if (!waiting) return reload();
  nav.serviceWorker!.addEventListener("controllerchange", () => reload(), { once: true });
  waiting.postMessage("skip-waiting");
}
