#!/usr/bin/env bash
# The `bridge` service of an Orca-repo preview: the API the preview's Vite proxies `/api` to
# (ORCA_API_PORT={svc:bridge} in the `web` service). Run from the previewed worktree.
#
#   preview-orca.sh <port>
#
# A preview used to proxy `/api` to MAIN's bridge on :8787, so the branch's frontend showed main's
# numbers (a Cost chart that read 0 under a branch that had fixed it) and nobody could tell. Now it
# starts the BRANCH's own bridge on <port> against the shared database, in preview-bridge mode
# (ORCA_PREVIEW_BRIDGE=1, server/db.ts `previewBridge`): it never applies a migration, never
# publishes this instance's state, runs none of the startup side effects, and refuses every write
# route. When that bridge can't run — a branch from before preview-bridge mode existed (which would
# start a FULL second bridge, so it is never launched), or one whose migrations the shared database
# lacks — <port> forwards to the main bridge instead. Either way the page's BridgeLabel names the
# bridge that actually answered (from /api/config).
set -u
port="$1"
main="${ORCA_MAIN_API_PORT:-8787}"

forward_to_main() {
  echo "[orca] $1 — this preview's /api is the MAIN bridge (:$main), and the page says so"
  PORT="$port" MAIN="$main" exec bun -e '
    const main = `http://127.0.0.1:${process.env.MAIN}`;
    Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", idleTimeout: 0,
      fetch: (r) => { const u = new URL(r.url); return fetch(main + u.pathname + u.search, { method: r.method, headers: r.headers, body: r.body, redirect: "manual" }); } });'
}

if ! grep -q ORCA_PREVIEW_BRIDGE server/db.ts 2>/dev/null; then
  forward_to_main "this branch predates preview bridges"
fi
ORCA_PREVIEW_BRIDGE=1 ORCA_API_PORT="$port" ORCA_BIND=127.0.0.1 ORCA_ALLOW_WORKTREE_MIGRATIONS= bun server/index.ts
forward_to_main "the branch's bridge exited ($?)"
