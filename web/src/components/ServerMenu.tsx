// The server switcher's surfaces (lib/server.ts holds the logic): the top bar's server menu — a
// tinted label with the side's name, in front of the repo menu — the Add server dialog, and the one
// inline message for a chosen server that is offline or refuses this browser. All of it renders
// nothing while Settings → Server switcher is off.
import { useEffect, useState, useSyncExternalStore } from "react";
import { atom, useAtom } from "jotai";
import { ChevronsUpDown, Plus, ServerOff } from "lucide-react";
import { poll } from "@/lib/poll";
import {
  addManualServer, apiFetch, chosenServer, currentServer, fetchServers, homeOrigin, manualServers, mergeServers, onManualChange,
  serverTone, switchServer, useServerStatus, useSwitcherOn, type ServerEntry, type ServersAnswer,
} from "@/lib/server";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ONE poll of the home server's GET /api/servers, shared by every reader (the menu, the palette),
// running only while one is mounted and the switcher is on.
let answer: ServersAnswer | null = null;
const subs = new Set<() => void>();
let stop: (() => void) | undefined;
const changed = () => subs.forEach((f) => f());
onManualChange(changed);
function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) stop = poll(() => fetchServers().then((a) => { answer = a; changed(); }), 30_000);
  return () => { subs.delete(cb); if (!subs.size) { stop?.(); stop = undefined; } };
}
let snapshot: { key: string; list: ServerEntry[] } = { key: "", list: [] };
function list(): ServerEntry[] {
  const manual = manualServers();
  const key = JSON.stringify([answer, manual]);
  if (key !== snapshot.key) snapshot = { key, list: mergeServers(answer, manual, homeOrigin()) };
  return snapshot.list;
}
const noSubscribe = () => () => {};
/** The menu's rows (home first, then the home server's list, then the ones added by hand). With the
 *  switcher off it fetches nothing. */
export function useServerList(): ServerEntry[] {
  const on = useSwitcherOn();
  return useSyncExternalStore(on ? subscribe : noSubscribe, list);
}
/** Tests: forget the cached answer. */
export function _resetServerList(): void { answer = null; snapshot = { key: "", list: [] }; }

/** The Add server dialog's open state — the menu and the palette open the same one. */
export const addServerOpenAtom = atom(false);

const Dot = ({ online }: { online?: boolean }) => (
  <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", online === undefined ? "bg-geist-gray" : online ? "bg-geist-green" : "bg-geist-red")} />
);
const onlineText = (s: ServerEntry) => (s.online === undefined ? "added by hand" : s.online ? "online" : "offline");

/** The top bar's server menu, in front of the repo menu. Its trigger is the side's tinted label. */
export function ServerMenu() {
  const on = useSwitcherOn();
  const servers = useServerList();
  const [, setAdd] = useAtom(addServerOpenAtom);
  if (!on) return null;
  const current = currentServer(servers);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-slot="server-menu" aria-label={`Server: ${current.name}. Switch server`}
            className={cn("flex h-7 max-w-[8rem] shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium md:max-w-[12rem]", serverTone(current.name))}>
            <span data-slot="server-label" className="truncate">{current.name}</span>
            <ChevronsUpDown className="size-3 shrink-0 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          <DropdownMenuLabel>Server</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current.url} onValueChange={(url) => {
            const s = servers.find((x) => x.url === url);
            if (s && url !== current.url) switchServer(s.self ? null : s);
          }}>
            {servers.map((s) => (
              <DropdownMenuRadioItem key={s.url} value={s.url} data-server={s.name} aria-label={`${s.name}, ${onlineText(s)}`}>
                <Dot online={s.online} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="text-muted-foreground text-xs">{s.self ? "home" : onlineText(s)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-slot="add-server" onSelect={() => setAdd(true)}><Plus className="size-4" />Add server by URL…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddServerDialog />
    </>
  );
}

/** Add a server by URL: the fallback for one the home server's list lacks. Adding switches to it. */
export function AddServerDialog() {
  const [open, setOpen] = useAtom(addServerOpenAtom);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dialog) return;
    if (open && !dialog.open) { setError(""); dialog.showModal(); dialog.querySelector("input")?.focus(); }
    else if (!open && dialog.open) dialog.close();
  }, [open, dialog]);
  const add = () => {
    const s = addManualServer(url, name);
    if (!s) return setError("Type an http:// address, for example http://smf-box:8787.");
    setOpen(false); setUrl(""); setName("");
    switchServer(s);
  };
  return (
    <dialog ref={setDialog} data-slot="add-server-dialog" aria-label="Add server"
      onClose={() => setOpen(false)} onCancel={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialog) setOpen(false); }}
      className="bg-card text-foreground m-auto mt-[12vh] w-[92vw] max-w-sm rounded-lg border p-0 shadow-modal backdrop:bg-black/50">
      <form method="dialog" className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <h2 className="text-sm font-semibold">Add server</h2>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">Address</span>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://smf-box:8787" inputMode="url" autoCapitalize="off" autoCorrect="off" className="bg-card h-9" />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">Name (optional)</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="SMF" className="bg-card h-9" />
        </label>
        {error && <p role="alert" className="text-geist-red text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" size="sm">Add and switch</Button>
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
  const servers = useServerList();
  const chosen = chosenServer();
  useEffect(() => (chosen ? poll(() => apiFetch("/api/config", { cache: "no-store" }).then((r) => { if (r.ok && configFailed) window.location.reload(); }), 5_000) : undefined), [chosen?.url, configFailed]);
  if (!chosen) return null;
  const home = servers.find((s) => s.self)?.name ?? "Home";
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
