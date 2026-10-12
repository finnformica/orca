// A cloud preview opened from the laptop: the relaying bridge forwards the opened service's port to
// localhost (server/forward.ts) so the browser gets a secure context — a plain-http tailnet name
// rendered branch-demo blank (crypto.randomUUID is undefined there).
import { afterAll, expect, test } from "bun:test";
import { native } from "./happydom";
import * as forward from "../server/forward";

// The "cloud" service: a small HTTP server on one port; the forward listens on another (one host
// in a test, so the numbers differ — in production they match across machines).
const big = "x".repeat(3 * 1024 * 1024); // a Vite-chunk-sized body, to exercise partial writes
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => new native.Response(new URL(req.url).pathname === "/big" ? big : `hi from ${req.headers.get("host")}`) });
const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new native.Response("taken") }); // a port a local preview holds
afterAll(() => { upstream.stop(true); local.stop(true); });

test("localize forwards the opened service to localhost and leaves the rest on the owner's URL", async () => {
  const port = upstream.port! + 1000;
  const svcs = [
    { name: "frontend", port, url: `http://orca-box:${port}`, open: true },
    { name: "backend", port: upstream.port!, url: `http://orca-box:${upstream.port}`, open: false },
  ];
  // The forward targets the same port number on the host; here that host port IS the upstream.
  expect(forward.ensure(port, "127.0.0.1", upstream.port)).toBe(true);
  const out = forward.localize("/wt/feat", svcs, "127.0.0.1");
  expect(out[0]!.url).toBe(`http://localhost:${port}`);
  expect(out[1]!.url).toBe(`http://orca-box:${upstream.port}`); // untouched
  expect(await (await native.fetch(`http://127.0.0.1:${port}/`)).text()).toBe(`hi from 127.0.0.1:${port}`);
  const body = await (await native.fetch(`http://127.0.0.1:${port}/big`)).text();
  expect(body.length).toBe(big.length); // nothing lost to backpressure
  forward.release("/wt/feat");
  await expect(native.fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(); // forward gone with the preview
});

test("a port a local preview already holds is left alone: the owner's URL stays", () => {
  const svcs = [{ name: "frontend", port: local.port!, url: `http://orca-box:${local.port}`, open: true }];
  expect(forward.localize("/wt/other", svcs, "127.0.0.1")[0]!.url).toBe(`http://orca-box:${local.port}`);
});
