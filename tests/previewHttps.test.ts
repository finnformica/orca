// Secure-context previews over the tailnet: a repo with `previewSecureContext` gets each service
// served over HTTPS by `tailscale serve` on the box (server/tsserve.ts), the browser gets the https
// ts.net URL, the commands get it through `{url:name}` / `{hosts}`, and stop removes the entries.
// A fake `tailscale` (ORCA_TAILSCALE_CMD) logs its argv; no tailnet is touched.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandCommand, pickHttpsPorts, start, status, stop } from "../server/preview";
import { certHost, wanted } from "../server/tsserve";

const ctx = { name: "frontend", ports: { frontend: 31000, backend: 32000 }, db: "orca_x", host: "100.1.2.3", bind: "0.0.0.0" };

test("{url:name} is the https ts.net URL on an HTTPS preview, else the plain http host:port", () => {
  const cmd = "export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS={hosts} VITE_BACKEND_URL={url:backend} && vite --host {bind} --port {port}";
  expect(expandCommand(cmd, ctx)).toBe("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=100.1.2.3 VITE_BACKEND_URL=http://100.1.2.3:32000 && vite --host 0.0.0.0 --port 31000");
  const https = { host: "box.tail.ts.net", ports: { frontend: 35000, backend: 36000 } };
  expect(expandCommand(cmd, { ...ctx, https })).toBe("export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=100.1.2.3,box.tail.ts.net VITE_BACKEND_URL=https://box.tail.ts.net:36000 && vite --host 0.0.0.0 --port 31000");
  // The old placeholders are unchanged: a config that still says http://{host}:{svc:backend} keeps working.
  expect(expandCommand("http://{host}:{svc:backend} {db}", { ...ctx, https })).toBe("http://100.1.2.3:32000 orca_x");
  // One host only once (a laptop: host and nothing else).
  expect(expandCommand("{hosts}", { ...ctx, host: "localhost" })).toBe("localhost");
});

test("pickHttpsPorts stays in range, avoids taken and busy ports, and gives a pair for httpsNextPort", async () => {
  const busy = new Set([30001]);
  for (let i = 0; i < 50; i++) {
    const out = await pickHttpsPorts([{ name: "backend", httpsNextPort: true }, { name: "frontend" }], [30000, 30005], new Set([30000]), async (p) => !busy.has(p));
    const b = out.backend!, f = out.frontend!;
    for (const p of [b, b + 1, f]) { expect(p).toBeGreaterThanOrEqual(30000); expect(p).toBeLessThanOrEqual(30005); }
    for (const p of [b, b + 1, f]) { expect(p).not.toBe(30000); expect(p).not.toBe(30001); }
    expect(new Set([b, b + 1, f]).size).toBe(3);
  }
  await expect(pickHttpsPorts([{ name: "a", httpsNextPort: true }], [30000, 30001], new Set([30001]), async () => true)).rejects.toThrow("no free HTTPS port");
});

test("certHost takes the ts.net name only when the tailnet grants it a cert; wanted is on for a box bind", () => {
  expect(certHost({ Self: { DNSName: "box.tail.ts.net." }, CertDomains: ["box.tail.ts.net"] })).toBe("box.tail.ts.net");
  expect(certHost({ Self: { DNSName: "box.tail.ts.net." }, CertDomains: null })).toBeUndefined();
  expect(certHost(null)).toBeUndefined();
  expect(wanted(undefined, "0.0.0.0")).toBe(true); // the box
  expect(wanted(undefined, "127.0.0.1")).toBe(false); // a laptop: its page uses the localhost forward
  expect(wanted("1", "127.0.0.1")).toBe(true);
  expect(wanted("0", "0.0.0.0")).toBe(false);
});

let dir = "";
const saved: Record<string, string | undefined> = {};
const ENV = ["ORCA_TAILSCALE_CMD", "ORCA_PREVIEW_HTTPS", "ORCA_PREVIEW_HTTPS_HOST", "ORCA_PREVIEW_HOST", "ORCA_PREVIEW_BIND"];
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-https-"));
  const fake = join(dir, "tailscale");
  await writeFile(fake, `#!/bin/sh\necho "$*" >> '${join(dir, "ts.log")}'\n`);
  await chmod(fake, 0o755);
  for (const k of ENV) saved[k] = process.env[k];
  Object.assign(process.env, { ORCA_TAILSCALE_CMD: fake, ORCA_PREVIEW_HTTPS: "1", ORCA_PREVIEW_HTTPS_HOST: "box.tail.ts.net", ORCA_PREVIEW_HOST: "100.1.2.3", ORCA_PREVIEW_BIND: "0.0.0.0" });
});
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const tsLog = async (): Promise<string[]> => existsSync(join(dir, "ts.log")) ? (await readFile(join(dir, "ts.log"), "utf8")).trim().split("\n") : [];

test("an HTTPS preview serves each service on the tailnet, hands out the https URL, and stop removes it", async () => {
  const key = await mkdtemp(join(dir, "wt-"));
  const services = [
    { name: "backend", command: "printf '%s' '{port}' > backend.out", httpsNextPort: true },
    { name: "frontend", open: true, command: "printf '%s' 'VITE_BACKEND_URL={url:backend} HOSTS={hosts}' > frontend.out" },
  ];
  await start(key, key, services, [30000, 40000], { https: true });
  for (let i = 0; i < 40 && !(existsSync(join(key, "frontend.out")) && existsSync(join(key, "backend.out"))); i++) await Bun.sleep(25);
  const backendPort = Number(await readFile(join(key, "backend.out"), "utf8"));

  const adds = (await tsLog()).filter((l) => l.startsWith("serve --bg"));
  const map = Object.fromEntries(adds.map((l) => { const m = /--https=(\d+) http:\/\/127\.0\.0\.1:(\d+)/.exec(l)!; return [Number(m[2]), Number(m[1])]; }));
  expect(adds).toHaveLength(3); // backend, backend + 1 (collab), frontend
  const backendHttps = map[backendPort]!;
  expect(map[backendPort + 1]).toBe(backendHttps + 1); // the frontend reaches collab at the backend URL's port + 1
  expect(await readFile(join(key, "frontend.out"), "utf8")).toBe(`VITE_BACKEND_URL=https://box.tail.ts.net:${backendHttps} HOSTS=100.1.2.3,box.tail.ts.net`);

  const svcs = await status(key);
  const front = svcs.find((s) => s.name === "frontend")!;
  expect(front.url).toBe(`https://box.tail.ts.net:${map[front.port]}`); // the box UI and a phone open this
  expect(front.localUrl).toBeUndefined(); // bound beyond loopback: no localUrl here (a laptop forwards its own)

  stop(key, true);
  const offs = (await tsLog()).filter((l) => l.endsWith(" off")).map((l) => Number(/--https=(\d+)/.exec(l)![1])).sort();
  expect(offs).toEqual(Object.values(map).sort()); // every entry it added, and nothing else
});

test("a repo without previewSecureContext gets no serve entries and the plain http URL", async () => {
  const key = await mkdtemp(join(dir, "wt-"));
  const before = (await tsLog()).length;
  await start(key, key, [{ name: "frontend", open: true, command: "printf '%s' '{url:frontend}' > f.out" }], [30000, 40000]);
  for (let i = 0; i < 40 && !existsSync(join(key, "f.out")); i++) await Bun.sleep(25);
  const port = (await status(key))[0]!.port;
  expect(await readFile(join(key, "f.out"), "utf8")).toBe(`http://100.1.2.3:${port}`);
  expect((await status(key))[0]!.url).toBe(`http://100.1.2.3:${port}`);
  stop(key, true);
  expect((await tsLog()).length).toBe(before);
});
