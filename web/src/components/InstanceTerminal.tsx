// The instance web terminal: a real shell on one machine (server/terminal.ts), drawn by xterm.js over
// ONE WebSocket. Opened from an instance card's Terminal action, as a full-height panel — on a phone
// a full-screen sheet sized to the visual viewport, so the extra-keys row sits right above the
// keyboard. The terminal fits its width, and every resize (a rotate, the keyboard) resizes the PTY.
// xterm loads only when a panel opens, so the board's bundle does not carry it. Closing the panel
// closes the socket, and the bridge closes the PTY with it.
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, RotateCw, X } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css"; // small; the script itself loads only when a panel opens
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { StatusDot } from "@/components/console";
import { useSwipeToClose } from "@/lib/gestures";
import { useCoarse, useNarrow } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { apiPort } from "../store";
import { TERMINAL_KEYS, ctrlChord, terminalClosedText, terminalSocketUrl } from "../workstream";

type State = { kind: "connecting" } | { kind: "open" } | { kind: "closed"; text: string };

// The card's own colours (styles.css: #fff light, #161616 dark), so the screen has no box of its own.
const THEMES = {
  dark: { background: "#161616", foreground: "#ededed", cursor: "#ededed", selectionBackground: "#ffffff33" },
  light: { background: "#ffffff", foreground: "#171717", cursor: "#171717", selectionBackground: "#0070f333" },
};

export function InstanceTerminal({ instance, open, onClose }: { instance: string; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const narrow = useNarrow();
  const keysRow = useCoarse() || narrow;
  const swipe = useSwipeToClose(() => ref.current, onClose, narrow);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      data-slot="instance-terminal"
      onClose={onClose}
      onCancel={(e) => e.preventDefault()} // Esc belongs to the shell (vi, less), not the panel
      // No display utility on the <dialog> itself (it would beat the UA's closed `display: none`).
      className="bg-card text-foreground m-auto h-[90vh] w-[90vw] max-w-5xl rounded-lg border p-0 shadow-modal backdrop:bg-black/50 max-md:sheet"
    >
      {open && <Session instance={instance} keysRow={keysRow} swipe={swipe} onClose={onClose} />}
    </dialog>
  );
}

function Session({ instance, keysRow, swipe, onClose }: { instance: string; keysRow: boolean; swipe: ReturnType<typeof useSwipeToClose>; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const sock = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>({ kind: "connecting" });
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const [pasteBox, setPasteBox] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const send = (d: string) => {
    const ws = sock.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d }));
  };

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setState({ kind: "connecting" });
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const dark = document.documentElement.classList.contains("dark");
      const t = new Terminal({
        fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace", // a canvas font: no var()
        fontSize: window.matchMedia("(max-width: 767px)").matches ? 12 : 13,
        cursorBlink: true, scrollback: 5000, theme: dark ? THEMES.dark : THEMES.light,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(host.current);
      fit.fit();
      term.current = t;
      const ws = new WebSocket(terminalSocketUrl(location, apiPort(), instance, t.cols, t.rows));
      ws.binaryType = "arraybuffer";
      sock.current = ws;
      ws.onopen = () => { setState({ kind: "open" }); t.focus(); };
      ws.onmessage = (e) => t.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      ws.onclose = (e) => { if (!disposed) setState({ kind: "closed", text: terminalClosedText(e.code, e.reason) }); };
      const input = t.onData((d) => {
        if (ctrlRef.current) { setCtrl(false); send(ctrlChord(d)); } else send(d);
      });
      const resized = t.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", c: cols, r: rows })); });
      // Fit on every size change: a rotate, the keyboard opening (the sheet follows the visual viewport).
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
      ro.observe(host.current);
      cleanup = () => { ro.disconnect(); input.dispose(); resized.dispose(); ws.close(); t.dispose(); };
    })();
    return () => { disposed = true; cleanup(); sock.current = null; term.current = null; };
  }, [instance, attempt]);

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

  const status = state.kind === "open" ? "Connected" : state.kind === "connecting" ? "Connecting…" : "Closed";
  return (
    <div className="flex h-full flex-col">
      <div {...swipe} className="flex items-center justify-between gap-2 border-b px-3 py-2 max-md:touch-none">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate font-medium">Terminal · {instance}</span>
          <span data-slot="terminal-status" className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <StatusDot tone={state.kind === "open" ? "ready" : state.kind === "connecting" ? "building" : "neutral"} />{status}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {state.kind === "closed" && (
            <Tip label="Reconnect">
              <Button size="icon" variant="ghost" className="size-7 max-md:size-11" aria-label="Reconnect" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw className="size-4" />
              </Button>
            </Tip>
          )}
          <Tip label="Close terminal">
            <Button size="icon" variant="ghost" className="size-7 max-md:size-11" aria-label="Close terminal" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </Tip>
        </div>
      </div>
      {state.kind === "closed" && (
        <div data-slot="terminal-closed" className="text-muted-foreground border-b px-3 py-2 text-xs">{state.text}</div>
      )}
      <div className="bg-card min-h-0 flex-1 p-2">
        <div ref={host} data-slot="terminal-screen" className="h-full w-full overflow-hidden" />
      </div>
      {pasteBox && (
        <form className="flex items-center gap-2 border-t px-2 py-1.5" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget.elements.namedItem("paste") as HTMLInputElement; if (f.value) send(f.value); setPasteBox(false); term.current?.focus(); }}>
          <input name="paste" autoFocus aria-label="Text to paste" placeholder="Paste here, then Send" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="border-input bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-base md:text-sm" />
          <Button type="submit" size="sm" variant="secondary">Send</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setPasteBox(false)}>Cancel</Button>
        </form>
      )}
      {keysRow && (
        <div data-slot="terminal-keys" role="toolbar" aria-label="Extra keys" className="flex gap-1 overflow-x-auto border-t px-2 py-1.5">
          {TERMINAL_KEYS.map((k) => (
            <Button key={k.id} type="button" size="sm" variant="secondary" aria-pressed={k.id === "ctrl" ? ctrl : undefined}
              aria-label={k.id === "paste" ? "Paste" : k.label}
              // Keep the terminal's focus (and the phone's keyboard) through the tap.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => key(k.id, k.send)}
              className={cn("h-11 min-w-11 flex-1 px-2 font-mono text-sm", k.id === "ctrl" && ctrl && "bg-accent text-foreground border-[var(--geist-blue)]")}>
              {k.id === "paste" ? <ClipboardPaste className="size-4" /> : k.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
