// The server switcher's surfaces (lib/server.ts holds the logic): the top bar's server menu — the
// repos selector's pattern (a plain trigger, a radio list), with a status dot per server — the Add
// server dialog, and the one inline message for a chosen server that is offline or refuses this
// browser. The menu renders nothing until there is something to switch to or to add (`showServerMenu`).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { atom, useAtom } from "jotai";
import { Check, ChevronsUpDown, Plus, ServerOff } from "lucide-react";
import { poll } from "@/lib/poll";
import {
  apiFetch, chosenServer, currentServer, fetchServers, homeOrigin, knownServers, mergeServers, onKnownChange, probeServer,
  rememberServer, serverOrigin, showServerMenu, switchServer, useServerStatus,
  type Probe, type ServerEntry, type ServerHealth, type ServersAnswer,
} from "@/lib/server";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ONE store for every reader (the menu, the palette, the offline message): the home server's GET
// /api/servers once a minute, and a health check of every other server FROM THIS BROWSER — each
// with its own short timeout, so a slow one never holds the others or the menu. Opening the menu
// checks again; until a server answers it shows its last result (grey before the first).
let answer: ServersAnswer | null = null;
let probes: Record<string, Probe> = {};
const inflight = new Set<string>();
const subs = new Set<() => void>();
let stop: (() => void) | undefined;
const changed = () => subs.forEach((f) => f());
onKnownChange(changed);

/** Check every server in the list; `all` also re-checks the ones with a result. A server found in
 *  an answer is checked as soon as it appears. */
export function checkServers(all = false): void {
  for (const s of list()) {
    if (s.self || inflight.has(s.url) || (!all && s.url in probes)) continue;
    inflight.add(s.url);
    void probeServer(s.url).then((p) => {
      inflight.delete(s.url);
      probes = { ...probes, [s.url]: p };
      // A known server goes by its own name from now on (an added IP becomes "personal").
      if (p.health === "online" && knownServers().some((k) => k.url === s.url)) rememberServer({ url: s.url, name: p.answer.self.name });
      changed();
      checkServers();
    });
  }
}
async function refresh(): Promise<void> {
  answer = await fetchServers();
  if (answer) rememberServer({ url: homeOrigin(), name: answer.self.name }); // this browser opened it
  changed();
  checkServers(true);
}
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) stop = poll(refresh, 60_000);
  return () => { subs.delete(cb); if (!subs.size) { stop?.(); stop = undefined; } };
}
let snapshot: { key: string; list: ServerEntry[] } = { key: "", list: [] };
function list(): ServerEntry[] {
  const known = knownServers();
  const chosen = chosenServer();
  const key = JSON.stringify([answer, known, probes, chosen]);
  if (key !== snapshot.key) snapshot = { key, list: mergeServers(homeOrigin(), answer, known, probes, chosen) };
  return snapshot.list;
}
const view = () => ({ list: list(), answer });
let viewSnap = view();
const getView = () => { const v = view(); if (v.list !== viewSnap.list || v.answer !== viewSnap.answer) viewSnap = v; return viewSnap; };

/** The servers, the home server's answer and whether the top bar shows the menu. */
export function useServers(): { servers: ServerEntry[]; answer: ServersAnswer | null; visible: boolean } {
  const v = useSyncExternalStore(subscribe, getView);
  return { servers: v.list, answer: v.answer, visible: showServerMenu(v.answer, v.list) };
}
/** Tests: forget the cached answer and results. */
export function _resetServerList(): void { answer = null; probes = {}; inflight.clear(); snapshot = { key: "", list: [] }; viewSnap = view(); }

/** The Add server dialog's open state — the menu and the palette open the same one. */
export const addServerOpenAtom = atom(false);

const DOT: Record<ServerHealth, string> = { online: "bg-geist-green", offline: "bg-geist-red", refused: "bg-geist-red", checking: "bg-geist-gray" };
const healthText = (h: ServerHealth) => (h === "online" ? "online" : h === "checking" ? "checking" : h === "refused" ? "refused this browser" : "offline");
const Dot = ({ health }: { health: ServerHealth }) => (
  <span aria-hidden="true" data-health={health} className={cn("inline-block size-2 shrink-0 rounded-full", DOT[health])} />
);

/** A server's theme colour, as a small rounded square (Slack's workspace tile). */
const Swatch = ({ color }: { color: string }) => (
  <span aria-hidden="true" data-slot="server-swatch" className="inline-block size-3 shrink-0 rounded-[3px]" style={{ background: color }} />
);

/** The top bar's server menu, in front of the repo menu: the repos selector's look, the current
 *  server checked, each server's colour, display name and status dot. */
export function ServerMenu() {
  const { servers, answer, visible } = useServers();
  const [, setAdd] = useAtom(addServerOpenAtom);
  // Add server opens its modal dialog only once the menu has closed, and stops the menu giving focus
  // back to its trigger: opened while the menu closed, the trigger took the focus back and the first
  // keystrokes went to the page (its shortcuts — the preview typed into "C" and "O").
  const adding = useRef(false);
  if (!visible) return null;
  const current = currentServer(servers);
  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) checkServers(true); }}>
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="server-menu" aria-label={`Server: ${current.label}, ${healthText(current.health)}. Switch server`}
            className="hover:bg-accent/60 flex h-8 max-w-[10rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium md:max-w-[14rem]">
            <Swatch color={current.color} />
            <span data-slot="server-label" className="truncate">{current.label}</span>
            <Dot health={current.health} />
            <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[12rem] max-w-[18rem]"
          onCloseAutoFocus={(e) => { if (adding.current) { adding.current = false; e.preventDefault(); setAdd(true); } }}>
          <DropdownMenuRadioGroup value={current.url} onValueChange={(url) => {
            const s = servers.find((x) => x.url === url);
            if (s && url !== current.url) switchServer(s.self ? null : s);
          }}>
            {servers.map((s) => {
              const down = s.health === "offline" || s.health === "refused";
              return (
                <DropdownMenuRadioItem key={s.url} value={s.url} data-server={s.name} aria-label={`${s.label}, ${healthText(s.health)}`}
                  disabled={down && s.url !== current.url} indicator={<Check className="size-3.5" />}>
                  <Swatch color={s.color} />
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  <Dot health={s.health} />
                  {down && <span className="text-muted-foreground text-xs">{s.health === "refused" ? "refused" : "offline"}</span>}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-slot="add-server" onSelect={() => { adding.current = true; }}>
            <Plus className="size-4" />Add server…
          </DropdownMenuItem>
          {answer && !answer.tailscaleApi && (
            <p data-slot="server-hint" className="text-muted-foreground px-2 pt-0.5 pb-1.5 text-xs">
              To list every server, set <code className="font-mono">TS_OAUTH_CLIENT_ID</code> and <code className="font-mono">TS_OAUTH_CLIENT_SECRET</code>.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Add a server by its address. Orca asks it at once: when it answers, it goes in the list under its
 *  own name and the app switches to it; when it does not, it goes in the list as offline and the
 *  dialog says so. Rendered once, in the shell (the menu and the palette open it). */
export function AddServerDialog() {
  const [open, setOpen] = useAtom(addServerOpenAtom);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) { setError(""); dialog.showModal(); dialog.querySelector("input")?.focus(); }
    else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);
  const add = async () => {
    const origin = serverOrigin(url);
    if (!origin) return setError("Type a server address, for example orca-personal-box:8787.");
    if (origin === homeOrigin()) return setError("This is the server you are on.");
    setBusy(true); setError("");
    const p = await probeServer(origin);
    setBusy(false);
    const known = rememberServer({ url: origin, name: p.health === "online" ? p.answer.self.name : undefined })!;
    probes = { ...probes, [origin]: p };
    changed();
    if (p.health !== "online") {
      return setError(p.health === "refused"
        ? `${known.name} refused this browser (403). It is in the list.`
        : `${known.name} did not answer. It is in the list as offline.`);
    }
    setOpen(false); setUrl("");
    switchServer(known);
  };
  return (
    <dialog ref={setDialog} data-slot="add-server-dialog" aria-label="Add server"
      onClose={() => setOpen(false)} onCancel={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialog) setOpen(false); }}
      className="bg-card text-foreground m-auto mt-[12vh] w-[92vw] max-w-sm rounded-lg border p-0 shadow-modal backdrop:bg-black/50">
      <form method="dialog" className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <h2 className="text-sm font-semibold">Add server</h2>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">Address</span>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="orca-personal-box:8787" inputMode="url" autoCapitalize="off" autoCorrect="off" className="bg-card h-9" />
        </label>
        {error && <p role="alert" data-slot="add-server-error" className="text-muted-foreground text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>{error ? "Close" : "Cancel"}</Button>
          <Button type="submit" size="sm" disabled={busy}>{busy ? "Checking…" : "Add and switch"}</Button>
        </div>
      </form>
    </dialog>
  );
}

/** Whether the inline server message shows: another server is chosen, and it is offline or
 *  refused this browser — or its config never loaded. */
export function useServerProblem(configFailed: boolean): boolean {
  const status = useServerStatus();
  return chosenServer() !== null && (status !== "ok" || configFailed);
}

/** The ONE message for a chosen server that is offline or refuses this browser (403): no toast,
 *  no stack. While it shows, the server is asked again every 5s; once it answers, a page whose config
 *  never loaded reloads, and a page that had loaded just carries on (its own polls catch up). */
export function ServerOffline({ configFailed }: { configFailed: boolean }) {
  const status = useServerStatus();
  const { servers } = useServers();
  const chosen = chosenServer();
  useEffect(() => (chosen ? poll(() => apiFetch("/api/config", { cache: "no-store" }).then((r) => { if (r.ok && configFailed) window.location.reload(); }), 5_000) : undefined), [chosen?.url, configFailed]);
  if (!chosen) return null;
  const home = servers.find((s) => s.self)?.label ?? "Home";
  const refused = status === "refused";
  return (
    <div role="status" data-slot="server-offline" className="bg-card mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm">
      <ServerOff className="text-geist-red size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{refused ? `${chosen.name} server refused this browser` : `${chosen.name} server unreachable, retrying`}</span>
        <span className="text-muted-foreground block text-xs">
          {refused ? "The server does not allow this origin (403). Check its server list." : "Check the server and the tailnet. Orca tries again every 5 seconds."}
        </span>
      </span>
      <Button type="button" size="sm" variant="secondary" data-slot="server-home" onClick={() => switchServer(null)}>Back to {home}</Button>
    </div>
  );
}
