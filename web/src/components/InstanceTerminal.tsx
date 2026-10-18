// The instance terminal: real shells on Orca's machines (server/terminal.ts), drawn by xterm.js, ONE
// WebSocket per session. Opened from Settings → Instances (each machine's Open terminal). It is laid
// out like the orchestrator: on a desktop the same right-hand side panel (components/SidePanel.tsx —
// header, width, resize from the left edge); on a phone a full page with a Back arrow, swiped right
// to close. It is mounted once, at the app's root, and stays mounted while closed, so its sessions
// survive moving around the app; only closing a tab ends a shell.
//
// Tabs: one per session, labelled with the machine's name; + opens a new session on a chosen machine.
// Each socket goes STRAIGHT to its machine's own bridge (`terminalTarget`) — no bridge relays another
// machine's shell. A dropped connection is retried (`terminalRetry`); a refusal (off, full, idle,
// exited) stays closed with its reason and a Reconnect button. xterm loads only when a session opens,
// so the board's bundle does not carry it.
import { useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { ClipboardPaste, Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css"; // small; the script itself loads only when a session opens
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/console";
import { PanelHeader, SidePanel } from "@/components/SidePanel";
import { orchestratorOpenAtom, terminalPanelAtom, terminalWidthAtom } from "@/lib/atoms";
import { useCoarse, useNarrow } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { instanceChoices, terminalContext, thisInstance, useInstanceTerminals } from "../store";
import {
  TERMINAL_KEYS, TERMINAL_STATUS, ctrlChord, terminalBlocked, terminalCloseTab, terminalClosedText, terminalNewTab, terminalRetry,
  terminalSelectTab, terminalSetOpen, terminalShowInstance, terminalTabLabels, terminalTarget, type TerminalStatus,
} from "../workstream";

/** Open the terminal panel on a machine (its newest session, else a new one). The orchestrator's
 *  panel sits in the same place, so it gives way. */
export function useOpenTerminal() {
  const setPanel = useSetAtom(terminalPanelAtom);
  const setOrchestrator = useSetAtom(orchestratorOpenAtom);
  return (instance: string) => { setOrchestrator(false); setPanel((s) => terminalShowInstance(s, instance)); };
}

/** The machines a session can open on: this one alone when there is no `instances` config. */
export const terminalMachines = (): string[] => {
  const here = thisInstance();
  return instanceChoices().length ? instanceChoices() : here ? [here] : [];
};

export function TerminalPanel() {
  const [panel, setPanel] = useAtom(terminalPanelAtom);
  const [orchestrator, setOrchestrator] = useAtom(orchestratorOpenAtom);
  const narrow = useNarrow();
  const coarse = useCoarse();
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const [reconnects, setReconnects] = useState<Record<string, number>>({});
  const close = () => setPanel((s) => terminalSetOpen(s, false));
  // One panel at a time on the right edge: opening the orchestrator hides this one (its shells run on).
  useEffect(() => { if (orchestrator) setPanel((s) => terminalSetOpen(s, false)); }, [orchestrator]);
  const labels = terminalTabLabels(panel.tabs);
  const active = panel.tabs.find((t) => t.id === panel.active);
  const status = active ? statuses[active.id] ?? "connecting" : undefined;
  const reconnect = (id: string) => setReconnects((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 }));
  if (!panel.tabs.length && !panel.open) return null;
  return (
    <SidePanel
      open={panel.open} onClose={close} slot="terminal" label="Terminal" labelledBy="terminal-title"
      widthAtom={terminalWidthAtom} swipe={coarse || narrow} fullScreen={narrow}
      header={(swipe) => (
        <PanelHeader
          slot="terminal-handle" swipe={swipe} touch={coarse || narrow}
          icon={<SquareTerminal className="size-3.5" />} onBack={narrow ? close : undefined}
          titleId="terminal-title" title={active ? `Terminal · ${labels[active.id]}` : "Terminal"}
          status={status && (
            <div data-slot="terminal-status" data-status={status} className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <StatusDot tone={TERMINAL_STATUS[status].tone} className="size-2" />{TERMINAL_STATUS[status].label}
            </div>
          )}
          actions={<>
            {active && status === "closed" && (
              <Button size="sm" variant="secondary" data-slot="terminal-reconnect" className="mr-1 h-7 gap-1.5 px-2 text-xs max-md:h-9" onClick={() => reconnect(active.id)}>
                <RotateCw className="size-3.5" />Reconnect
              </Button>
            )}
            {!narrow && (
              <Tip label="Close panel (the sessions keep running)">
                <Button size="icon" variant="ghost" className="size-7" aria-label="Close terminal panel" onClick={close}>
                  <X className="size-4" />
                </Button>
              </Tip>
            )}
          </>}
        />
      )}
    >
      <TabStrip
        tabs={panel.tabs} active={panel.active} labels={labels} statuses={statuses}
        onSelect={(id) => setPanel((s) => terminalSelectTab(s, id))}
        onClose={(id) => setPanel((s) => terminalCloseTab(s, id))}
        onNew={(instance) => { setOrchestrator(false); setPanel((s) => terminalNewTab(s, instance)); }}
      />
      <div className="relative min-h-0 flex-1">
        {panel.tabs.map((t) => (
          <Session
            key={t.id} instance={t.instance} visible={panel.open && t.id === panel.active} focus={!coarse}
            keysRow={coarse || narrow} reconnect={reconnects[t.id] ?? 0}
            onStatus={(s) => setStatuses((m) => (m[t.id] === s ? m : { ...m, [t.id]: s }))}
            onReconnect={() => reconnect(t.id)}
          />
        ))}
      </div>
    </SidePanel>
  );
}

/** The tabs: one per session (its status dot, its machine's name, ✕), then + for a new session. */
function TabStrip({ tabs, active, labels, statuses, onSelect, onClose, onNew }: {
  tabs: { id: string; instance: string }[]; active: string | null; labels: Record<string, string>; statuses: Record<string, TerminalStatus>;
  onSelect: (id: string) => void; onClose: (id: string) => void; onNew: (instance: string) => void;
}) {
  const on = useInstanceTerminals();
  const ctx = terminalContext();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2 max-md:h-12">
      <div role="tablist" aria-label="Terminal sessions" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const selected = t.id === active;
          const s = statuses[t.id] ?? "connecting";
          return (
            <div key={t.id} data-slot="terminal-tab" data-state={selected ? "active" : "inactive"}
              className={cn("group flex h-7 shrink-0 items-center rounded-md text-xs max-md:h-9", selected ? "bg-selected text-selected-foreground" : "text-muted-foreground hover:bg-accent/60")}>
              <button type="button" role="tab" aria-selected={selected} onClick={() => onSelect(t.id)}
                className="flex h-full items-center gap-1.5 pr-1 pl-2 font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
                <StatusDot tone={TERMINAL_STATUS[s].tone} className="size-1.5" />{labels[t.id]}
              </button>
              <Tip label={`Close ${labels[t.id]} (ends the shell)`}>
                <Button size="icon" variant="ghost" aria-label={`Close ${labels[t.id]}`} onClick={() => onClose(t.id)}
                  className="mr-0.5 size-5 rounded-sm hover:bg-transparent max-md:size-8">
                  <X className="size-3" />
                </Button>
              </Tip>
            </div>
          );
        })}
      </div>
      <DropdownMenu>
        <Tip label="New session">
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" data-slot="terminal-new" aria-label="New session" className="size-7 shrink-0 max-md:size-9">
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        {/* No focus back to +: the new session takes it, so the next keys go to its shell. */}
        <DropdownMenuContent align="end" className="min-w-48" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">New session on</DropdownMenuLabel>
          {terminalMachines().map((m) => {
            const why = terminalBlocked(m, on[m] === true, ctx);
            return (
              <DropdownMenuItem key={m} data-slot="terminal-new-on" data-instance={m} disabled={why !== null} onSelect={() => onNew(m)}>
                <SquareTerminal className="size-4" />
                <span className="flex min-w-0 flex-col">
                  <span>{m}</span>
                  {why && <span className="text-muted-foreground text-xs">{why}</span>}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** xterm's colours from the panel's own (the app theme, light or dark): computed off the screen's
 *  host, which carries `bg-card text-foreground`. A light page gets a palette whose white, yellow and
 *  bright colours stay readable on white. */
function themeOf(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const dark = document.documentElement.classList.contains("dark");
  const background = cs.backgroundColor || (dark ? "#161616" : "#ffffff");
  const foreground = cs.color || (dark ? "#ededed" : "#171717");
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: dark ? "#ffffff33" : "#0070f333",
    ...(dark ? {} : {
      black: "#171717", brightBlack: "#6b6b6b", white: "#6b6b6b", brightWhite: "#3d3d3d",
      green: "#1a7f37", brightGreen: "#116329", yellow: "#946300", brightYellow: "#a35200",
      blue: "#0058c4", brightBlue: "#0070f3", cyan: "#0b7285", brightCyan: "#0a6a7a", magenta: "#8250df", brightMagenta: "#6639ba",
    }),
  };
}

/** One session: the screen, the closed line, and on a phone the extra-keys row. Mounted while its tab
 *  exists (hidden while another tab shows), so switching tabs keeps the shell and its scrollback. */
function Session({ instance, visible, focus, keysRow, reconnect, onStatus, onReconnect }: {
  instance: string; visible: boolean; focus: boolean; keysRow: boolean; reconnect: number;
  onStatus: (s: TerminalStatus) => void; onReconnect: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fitRef = useRef<{ fit: () => void } | null>(null);
  const sock = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [closedText, setClosedText] = useState("");
  const [ready, setReady] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const [pasteBox, setPasteBox] = useState(false);
  const report = useRef(onStatus);
  report.current = onStatus;
  const shown = useRef(false);
  shown.current = visible && focus;
  useEffect(() => { report.current(status); }, [status]);

  const send = (d: string) => {
    const ws = sock.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
  };

  // The screen: made once per session. Input goes to whichever socket is current.
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
        if (disposed || !host.current) return;
        const el = host.current;
        const t = new Terminal({
          // A canvas font: no var(). The app's mono (styles.css `--font-mono`).
          fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: window.matchMedia("(max-width: 767px)").matches ? 14 : 13, lineHeight: 1.25,
          cursorBlink: true, scrollback: 5000, theme: themeOf(el),
        });
        const fit = new FitAddon();
        t.loadAddon(fit);
        t.open(el);
        term.current = t;
        fitRef.current = { fit: () => { try { if (el.offsetWidth) fit.fit(); } catch { /* hidden */ } } };
        fitRef.current.fit();
        const input = t.onData((d) => { if (ctrlRef.current) { setCtrl(false); send(ctrlChord(d)); } else send(d); });
        const resized = t.onResize(({ cols, rows }) => { const ws = sock.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", c: cols, r: rows })); });
        // Fit on every size change: a rotate, the keyboard (the page follows the visual viewport), a tab shown.
        const ro = new ResizeObserver(() => fitRef.current?.fit());
        ro.observe(el);
        // The app's theme toggles a class on <html>: follow it.
        const mo = new MutationObserver(() => { t.options.theme = themeOf(el); });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
        cleanup = () => { ro.disconnect(); mo.disconnect(); input.dispose(); resized.dispose(); t.dispose(); };
        setReady(true);
      } catch (e) {
        setClosedText(`The terminal could not start: ${e instanceof Error ? e.message : String(e)}`);
        setStatus("closed");
      }
    })();
    return () => { disposed = true; cleanup(); term.current = null; fitRef.current = null; };
  }, []);

  // The socket: one per connect — the first, a retry after a drop, or the user's Reconnect. A new
  // socket is a new shell (the server ends a shell with its socket), so the screen says so.
  useEffect(() => {
    const t = term.current;
    if (!ready || !t) return;
    let disposed = false, attempts = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const connect = (again: boolean) => {
      const target = terminalTarget(instance, terminalContext(), t.cols, t.rows);
      if ("reason" in target) { setClosedText(target.reason); setStatus("closed"); return; }
      setStatus(again ? "reconnecting" : "connecting");
      setClosedText("");
      const ws = new WebSocket(target.url);
      ws.binaryType = "arraybuffer";
      sock.current = ws;
      let wasOpen = false;
      ws.onopen = () => {
        wasOpen = true; attempts = 0;
        if (again) t.write("\r\n\x1b[2m— new shell —\x1b[0m\r\n");
        setStatus("connected");
        if (shown.current) t.focus();
      };
      ws.onmessage = (e) => t.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = (e) => {
        if (disposed || sock.current !== ws) return;
        const wait = terminalRetry(e.code, e.reason, wasOpen || attempts > 0, attempts);
        if (wait !== null) { attempts++; setStatus("reconnecting"); timer = setTimeout(() => connect(true), wait); return; }
        setClosedText(terminalClosedText(e.code, e.reason));
        setStatus("closed");
      };
    };
    connect(reconnect > 0);
    return () => { disposed = true; clearTimeout(timer); sock.current?.close(); sock.current = null; };
  }, [ready, instance, reconnect]);

  // Shown again (its tab chosen, the panel reopened): refit to the size it now has, and take focus.
  useEffect(() => {
    if (!visible) return;
    fitRef.current?.fit();
    if (focus) term.current?.focus();
  }, [visible]);

  const paste = async () => {
    // The clipboard API needs a secure context, which the plain-http tailnet is not: fall back to a
    // field the OS's own paste can fill.
    try {
      if (!window.isSecureContext || !navigator.clipboard?.readText) throw new Error("no clipboard");
      const text = await navigator.clipboard.readText();
      if (text) send(text);
      term.current?.focus();
    } catch { setPasteBox(true); }
  };
  const key = (id: string, bytes?: string) => {
    if (id === "ctrl") return setCtrl((c) => !c);
    if (id === "paste") return void paste();
    if (bytes) send(bytes);
    term.current?.focus();
  };

  return (
    <div data-slot="terminal-session" data-instance={instance} className={cn("absolute inset-0 flex flex-col", !visible && "invisible")} aria-hidden={!visible}>
      {status === "closed" && (
        <div data-slot="terminal-closed" className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
          <span className="min-w-0">{closedText}</span>
          <Button size="sm" variant="secondary" className="h-7 shrink-0 gap-1.5 px-2 text-xs max-md:h-9" onClick={onReconnect}>
            <RotateCw className="size-3.5" />Reconnect
          </Button>
        </div>
      )}
      {/* Padding like the chat's (p-3); the screen itself fills what is left. */}
      <div className="bg-card min-h-0 flex-1 p-3">
        <div ref={host} data-slot="terminal-screen" className="bg-card text-foreground h-full w-full overflow-hidden" />
      </div>
      {pasteBox && (
        <form className="flex items-center gap-2 border-t px-2 py-1.5" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget.elements.namedItem("paste") as HTMLInputElement; if (f.value) send(f.value); setPasteBox(false); term.current?.focus(); }}>
          <Input name="paste" autoFocus aria-label="Text to paste" placeholder="Paste here, then Send" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="h-9 min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="secondary">Send</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setPasteBox(false)}>Cancel</Button>
        </form>
      )}
      {keysRow && (
        <div data-slot="terminal-keys" role="toolbar" aria-label="Extra keys" className="flex gap-1 overflow-x-auto border-t px-2 py-2">
          {TERMINAL_KEYS.map((k) => (
            <Button key={k.id} type="button" size="sm" variant={k.id === "ctrl" && ctrl ? "default" : "outline"}
              aria-pressed={k.id === "ctrl" ? ctrl : undefined} aria-label={k.id === "paste" ? "Paste" : k.label}
              // Keep the terminal's focus (and the phone's keyboard) through the tap.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => key(k.id, k.send)}
              className="h-11 min-w-10 flex-1 px-1 font-mono text-sm">
              {k.id === "paste" ? <ClipboardPaste className="size-4" /> : k.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
