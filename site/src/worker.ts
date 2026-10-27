// The public site's one dynamic route: the Google OAuth callback bounce. Google sends the browser to
// this public origin (the OAuth app's authorized redirect domain); the Worker sends it on to the Orca
// server at ORCA_ORIGIN with the same query (code, state, scope), where the sign-in finishes.
// ORCA_ORIGIN is a Worker variable set in the Cloudflare dashboard, never in the repo.
// Every other path is a static file from public/ (wrangler.jsonc runs this Worker first only for /api/*).

export const CALLBACK_PATH = "/api/integrations/oauth/google/callback";

export type Env = { ORCA_ORIGIN?: string; ASSETS?: { fetch(req: Request): Promise<Response> } };

const text = (body: string, status: number) =>
  new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The configured Orca origin (scheme + host, no path), or undefined when unset or not a URL. */
export function orcaOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch { return undefined; }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === CALLBACK_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed.", 405);
      const origin = orcaOrigin(env.ORCA_ORIGIN);
      if (!origin) return text("Sign-in is not available: the Orca server address is not set.", 503);
      return new Response(null, { status: 302, headers: { location: `${origin}${CALLBACK_PATH}${url.search}`, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return text("Not found.", 404);
  },
};
