// The public site (site/): the Google OAuth callback bounce in its Worker, and the static pages Google
// checks for the OAuth app's branding. The Worker runs here as a plain module: no wrangler, no network.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker, { CALLBACK_PATH, orcaOrigin } from "../site/src/worker";

const PUBLIC = "https://orca.example.com";
const call = (path: string, env: Record<string, unknown>, init?: RequestInit) => worker.fetch(new Request(`${PUBLIC}${path}`, init), env as never);

describe("the callback bounce", () => {
  test("302 to ORCA_ORIGIN's callback with the same query string", async () => {
    const query = "?state=%2Bnew-0123abcd~ff00&code=4%2F0Ab-xy_z&scope=email+openid+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly";
    const r = await call(`${CALLBACK_PATH}${query}`, { ORCA_ORIGIN: "https://orca.internal.example/" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://orca.internal.example${CALLBACK_PATH}${query}`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    // A denied consent comes back with only error + state: kept as is.
    const denied = await call(`${CALLBACK_PATH}?error=access_denied&state=s~1`, { ORCA_ORIGIN: "https://orca.internal.example" });
    expect(denied.headers.get("location")).toBe(`https://orca.internal.example${CALLBACK_PATH}?error=access_denied&state=s~1`);
    // The origin only: a path in the variable is dropped, never joined.
    expect(orcaOrigin("https://orca.internal.example:8443/some/path")).toBe("https://orca.internal.example:8443");
  });

  test("503 with a short text when ORCA_ORIGIN is unset, empty or not a URL", async () => {
    for (const env of [{}, { ORCA_ORIGIN: "" }, { ORCA_ORIGIN: "  " }, { ORCA_ORIGIN: "not a url" }, { ORCA_ORIGIN: "javascript:alert(1)" }]) {
      const r = await call(`${CALLBACK_PATH}?code=c&state=s`, env);
      expect(r.status).toBe(503);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.text()).toBe("Sign-in is not available: the Orca server address is not set.\n");
    }
  });

  test("only GET and HEAD; every other path goes to the static files", async () => {
    expect((await call(CALLBACK_PATH, { ORCA_ORIGIN: PUBLIC }, { method: "POST" })).status).toBe(405);
    const seen: string[] = [];
    const ASSETS = { fetch: async (req: Request) => { seen.push(new URL(req.url).pathname); return new Response("page"); } };
    expect(await (await call("/privacy", { ASSETS })).text()).toBe("page");
    expect(seen).toEqual(["/privacy"]);
  });
});

describe("the static pages", () => {
  const dir = join(import.meta.dir, "../site/public");
  const page = (name: string) => readFileSync(join(dir, name), "utf8");

  test("home links to Privacy and Terms; privacy names the scope, the policy sentence and the contact", () => {
    expect(page("index.html")).toContain('href="/privacy"');
    expect(page("index.html")).toContain('href="/terms"');
    expect(page("index.html")).toContain('<a href="https://github.com/finnformica/orca">GitHub</a>'); // same tab: no target
    const privacy = page("privacy.html");
    const plain = privacy.replace(/<[^>]+>/g, "");
    for (const s of ["Finn Formica", "gmail.readonly", "Orca never sends mail", "encrypted", "finnformica@gmail.com"]) expect(plain).toContain(s);
    expect(plain).toContain("Orca's use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.");
    expect(page("terms.html")).toContain("finnformica@gmail.com");
  });

  test("dark, with the ASCII sea behind every page: hidden from screen readers, CSS only, still under reduced motion", () => {
    const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));
    for (const name of pages) expect(page(name)).toContain('<div class="sea" aria-hidden="true">');
    const css = page("styles.css");
    expect(css).toContain("background: #000;");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*animation-play-state: paused/);
  });

  test("no external requests: no script, and every src or stylesheet is a path on this site", () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".html") || f.endsWith(".css"))) {
      const body = page(name);
      expect(body).not.toContain("<script");
      expect(body).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
      for (const m of body.matchAll(/(?:src=|<link[^>]*href=|url\()["']?([^"')\s>]+)/g)) expect(m[1]!.startsWith("/")).toBe(true);
    }
  });
});
