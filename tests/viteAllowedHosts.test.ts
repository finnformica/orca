// Vite 5 403s a request whose Host header isn't in server.allowedHosts (localhost/bare IPs are
// always allowed, a tailnet name is not) — this is the pure logic that turns the preview env vars
// into that list. See CLAUDE.md "A preview command binds {bind}".
import { expect, test } from "bun:test";
import { allowedHosts } from "../web/vite.config";

test("allowedHosts: no preview env set, nothing extra allowed (localhost/IPs are implicit)", () => {
  expect(allowedHosts({})).toEqual([]);
});

test("allowedHosts: ORCA_PREVIEW_HOST is allowed, plus its short MagicDNS name and any ts.net name", () => {
  expect(allowedHosts({ ORCA_PREVIEW_HOST: "orca-box.tail622bd5.ts.net" })).toEqual([
    "orca-box.tail622bd5.ts.net",
    ".ts.net",
    "orca-box",
  ]);
});

test("allowedHosts: __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS is comma-separated and trimmed", () => {
  expect(
    allowedHosts({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "foo.ts.net, bar.ts.net" }),
  ).toEqual(["foo.ts.net", "bar.ts.net"]);
});

test("allowedHosts: both sources combine, blank entries dropped", () => {
  expect(
    allowedHosts({
      ORCA_PREVIEW_HOST: "orca-box.tail622bd5.ts.net",
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "",
    }),
  ).toEqual(["orca-box.tail622bd5.ts.net", ".ts.net", "orca-box"]);
});

test("allowedHosts: a non-ts.net ORCA_PREVIEW_HOST gets no ts.net wildcard or short name", () => {
  expect(allowedHosts({ ORCA_PREVIEW_HOST: "example.com" })).toEqual(["example.com"]);
});
