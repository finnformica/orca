// An offline Orca instance (a laptop asleep or off the tailnet) black-holes a TCP connect rather than
// refusing it, so every request that reached for it — /api/usage's merge, `?instance=local` vitals, a
// forward — hung for over a minute and held one of the browser's six connections. `reachable`
// (server/peer.ts) bounds the question to a connect within a few seconds and remembers the answer.
import { afterEach, expect, test } from "bun:test";
import { reachable, resetPeers, setProbe } from "../server/peer";

afterEach(() => setProbe());

test("peer: a black-holed address answers 'down' within the connect bound, then instantly from the cache", async () => {
  const t0 = Date.now();
  // TEST-NET-1: never routed, so the connect either fails at once or hangs — either way bounded.
  expect(await reachable("http://192.0.2.1:8787", 300)).toBe(false);
  expect(Date.now() - t0).toBeLessThan(2000);
  const t1 = Date.now();
  expect(await reachable("http://192.0.2.1:8787", 300)).toBe(false);
  expect(Date.now() - t1).toBeLessThan(50);
});

test("peer: a listening bridge is up; a closed port is down", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  try {
    expect(await reachable(`http://127.0.0.1:${server.port}`)).toBe(true);
  } finally { server.stop(true); }
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = closed.port;
  closed.stop(true);
  expect(await reachable(`http://127.0.0.1:${port}`)).toBe(false);
});

test("peer: concurrent callers share one probe, and a down answer is cached", async () => {
  let probes = 0;
  setProbe(async () => { probes++; await Bun.sleep(20); return false; });
  const answers = await Promise.all([reachable("http://laptop.test"), reachable("http://laptop.test"), reachable("http://laptop.test/api/x")]);
  expect(answers).toEqual([false, false, false]);
  expect(await reachable("http://laptop.test")).toBe(false);
  expect(probes).toBe(1);
  resetPeers();
  await reachable("http://laptop.test");
  expect(probes).toBe(2);
});
