// The secret store's routes for the USER (server/secrets.ts): Reveal in Settings > Secrets and the
// chat's `orca secret show` card read a value here; the public switch marks one.
//
// The reveal route is for the user's browser only, never an agent:
// - a POST from an Orca page: an Origin header that names this host or a known Orca server
//   (`terminal.originAllowed`), and `Sec-Fetch-Site: same-origin`, which a browser sets itself and a
//   page's script cannot. `bin/orca`, curl from a worker and a server-to-server forward send neither.
// - then the web terminal's owner check (`terminal.identify`): loopback, or the owner's own tailnet
//   device.
// - not under /api/orchestrator, which is forwarded to `orchestratorOn` without the Origin: the
//   bridge that served the page answers, from the shared database (the same key on every instance).
// A process on the box that forges every header passes, as it can read the key file anyway: the
// store is not a sandbox (docs/secrets.md). The check keeps the route off an agent's normal paths.
// Every reveal writes an audit row; the answer is `no-store`.
import * as secrets from "./secrets";
import * as terminal from "./terminal";
import type { OrcaConfig } from "./config";

export type SecretRouteDeps = {
  cfg: Pick<OrcaConfig, "instances" | "serverSwitcher">;
  /** The request's remote address (Bun's `requestIP`). */
  remote?: string;
  /** The owner check; tests pass their own. */
  identify?: (addr: string | undefined, owners: string[]) => Promise<terminal.Identity>;
};

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

/** Why a reveal request is not from an Orca page in the user's browser, or undefined. Pure. */
export function revealHeaderRefusal(headers: Headers): string | undefined {
  if (!headers.get("origin")) return "a reveal must come from an Orca page in a browser (no Origin header)";
  if (headers.get("sec-fetch-site") !== "same-origin") return "a reveal must come from the page this bridge serves (Sec-Fetch-Site is not same-origin)";
  return undefined;
}

export async function handleSecrets(req: Request, url: URL, body: Record<string, unknown>, deps: SecretRouteDeps): Promise<Response | undefined> {
  const p = url.pathname;
  try {
    if (p === "/api/secrets/reveal") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      const header = revealHeaderRefusal(req.headers);
      if (header) return json({ error: `Reveal refused: ${header}.` }, 403);
      if (!terminal.originAllowed(req.headers.get("origin"), req.headers.get("host"), await terminal.trustedOrigins(deps.cfg))) return json({ error: "Reveal refused: cross-origin request." }, 403);
      const owners = deps.cfg.serverSwitcher?.allowedLogins ?? [];
      const addr = terminal.callerAddress(deps.remote, req.headers);
      const id = await (deps.identify ? deps.identify(addr, owners) : terminal.identify(addr, undefined, undefined, owners));
      if (!id.ok) return json({ error: `Reveal refused: ${id.reason}.` }, 403);
      const who = `user (${id.who})`;
      // A chat card sends its token: only a real `orca secret show` made one (the mac).
      if (typeof body.token === "string") {
        const ref = secrets.verifyShowToken(body.token);
        if (!ref) return json({ error: "Reveal refused: the token is not one this bridge made." }, 403);
        return json(await secrets.revealToUser(ref, who, "chat (orca secret show)"));
      }
      return json(await secrets.revealToUser(String(body.ref ?? ""), who, "Settings > Secrets"));
    }
    if (p === "/api/orchestrator/secrets/mark" && req.method === "POST") {
      if (typeof body.public !== "boolean") return json({ error: "public (true or false) is required" }, 400);
      return json(await secrets.mark(String(body.name ?? ""), body.public, "user (Settings)"));
    }
  } catch (e) {
    if (e instanceof secrets.SecretError) return json({ error: e.message }, e.status);
    throw e;
  }
  return undefined;
}
