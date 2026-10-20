// HTTPS for previews over the tailnet, by `tailscale serve`.
//
// Why: a repo with `previewSecureContext` (branch-demo: crypto.randomUUID) needs a secure context.
// A plain-http tailnet address is not one, and `*.ts.net` is HSTS-preloaded, so http on the name is
// forced to https. `tailscale serve --https=<port>` terminates TLS with the tailnet's own cert for
// this machine's ts.net name and proxies to the service on loopback. The tailnet ACL admits only the
// preview port range, so the HTTPS ports come from that range too (server/preview.ts picks them).
// A laptop page on localhost keeps the loopback forward (server/forward.ts); this is for every
// other viewer (the box's own UI, a phone).

/** The tailscale CLI as argv. `ORCA_TAILSCALE_CMD` (space-separated) overrides it — the tests' fake.
 *  On Linux the service user needs root for `serve`; the box's `orca` user has passwordless sudo. */
export function command(): string[] {
  const override = process.env.ORCA_TAILSCALE_CMD?.trim();
  if (override) return override.split(/\s+/);
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  return process.platform === "linux" && !root ? ["sudo", "-n", "tailscale"] : ["tailscale"];
}

function run(args: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync([...command(), ...args], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

/** This machine's ts.net name from `tailscale status --json`, only when the tailnet grants it a
 *  cert (`CertDomains`). Pure, so the selection is testable without a tailnet. */
export function certHost(status: unknown): string | undefined {
  const s = status as { Self?: { DNSName?: unknown }; CertDomains?: unknown } | null;
  const name = typeof s?.Self?.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
  const certs = Array.isArray(s?.CertDomains) ? s.CertDomains : [];
  return name && certs.includes(name) ? name : undefined;
}

let cached: string | undefined;
/** The HTTPS host for previews: `ORCA_PREVIEW_HTTPS_HOST`, else the tailnet cert name. A found name
 *  is kept; a miss is read again next time (tailscaled down for a moment must not disable HTTPS). */
export function httpsHost(): string | undefined {
  if (process.env.ORCA_PREVIEW_HTTPS_HOST) return process.env.ORCA_PREVIEW_HTTPS_HOST;
  if (!cached) {
    const r = run(["status", "--json"]);
    try { cached = r.ok ? certHost(JSON.parse(r.out)) : undefined; } catch { cached = undefined; }
  }
  return cached;
}

/** Should this machine serve secure-context previews over HTTPS? `ORCA_PREVIEW_HTTPS`: `0` off, `1`
 *  on. Unset: on when previews bind beyond loopback (a box the tailnet reaches) — a laptop binds
 *  loopback and its own page uses localhost. Either way only with an HTTPS host. Pure over its inputs. */
export function wanted(flag: string | undefined, bind: string): boolean {
  if (flag === "0") return false;
  if (flag === "1") return true;
  return !["127.0.0.1", "localhost", "::1"].includes(bind);
}

export const enabled = (bind: string): boolean => wanted(process.env.ORCA_PREVIEW_HTTPS, bind) && !!httpsHost();

/** Serve https://<host>:<httpsPort> → http://127.0.0.1:<target>. False (with a log) on failure. */
export function add(httpsPort: number, target: number): boolean {
  const r = run(["serve", "--bg", "--yes", `--https=${httpsPort}`, `http://127.0.0.1:${target}`]);
  if (!r.ok) console.error(`orca: tailscale serve --https=${httpsPort} failed: ${r.out.split("\n").pop() ?? ""}`);
  return r.ok;
}

/** Remove one HTTPS port's serve entry. Callers pass only ports Orca added. */
export function remove(httpsPort: number): void {
  run(["serve", `--https=${httpsPort}`, "off"]);
}
