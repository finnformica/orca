#!/usr/bin/env bash
# Auto-deploy: pull main, install deps if they changed, build, restart — run every minute by
# orca-autodeploy.timer so the box updates itself as soon as main changes (CLAUDE.md "Deploying" →
# "Auto-deploy"). Idempotent and safe to run on a tick with nothing to do.
#
# Busy means the bridge is mid-orchestrator-wake (GET /api/orchestrator → running:true). A live
# agent-run lease (~/.orca/leases) is NOT busy: a worker survives a bridge restart
# (agent.adoptLeases re-adopts its lease), but an orchestrator wake does NOT — systemd killing the
# process mid-wake looks exactly like the orchestrator abandoning its reply (CLAUDE.md
# "Stability"). So this script only defers for the wake, and just tries again on the next tick.
#
# package.json or bun.lock changing between the old and new HEAD means `bun install
# --frozen-lockfile` runs before the build (a PR that adds a dependency, like #192's
# @radix-ui/react-hover-card, otherwise builds against stale node_modules and fails with a Rollup
# unresolved-import error while the box silently keeps serving the old build).
#
# A failed install or build never restarts the service — the old build keeps serving — and logs
# the tail.
set -euo pipefail

REPO="${ORCA_REPO:-/opt/orca}"
SERVICE="${ORCA_SERVICE_NAME:-orca}"
BRIDGE_URL="${ORCA_BRIDGE_URL:-http://127.0.0.1:8787}"
STATE_DIR="${ORCA_STATE_DIR:-$HOME/.orca}"
LOG="${STATE_DIR}/autodeploy.log"
mkdir -p "${STATE_DIR}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"${LOG}"; }

# The deploy lock: held for the whole run, so two deploys never overlap and the health watchdog
# (deploy/health-check.sh) never restarts the bridge under a deploy. A manual deploy takes it with
# `flock ~/.orca/deploy.lock <command>`. No flock (macOS): no lock.
if command -v flock >/dev/null; then
  exec 9>>"${STATE_DIR}/deploy.lock"
  if ! flock -n 9; then
    log "deferred: another deploy holds ${STATE_DIR}/deploy.lock"
    exit 0
  fi
fi

cd "${REPO}"
git fetch -q origin main

head_local="$(git rev-parse HEAD)"
head_remote="$(git rev-parse origin/main)"
if [[ "${head_local}" == "${head_remote}" ]]; then
  log "up to date at ${head_local:0:12}"
  exit 0
fi

# --- busy? (see header) ---
orchestrator_running() {
  local body
  body="$(curl -fsS --max-time 5 "${BRIDGE_URL}/api/orchestrator" 2>/dev/null)" || return 1
  [[ "${body}" == *'"running":true'* ]]
}

if orchestrator_running; then
  log "deferred: busy"
  exit 0
fi

deps_changed="$(git diff --name-only "${head_local}" "${head_remote}" -- package.json bun.lock)"

if ! git pull --ff-only -q; then
  log "error: git pull --ff-only failed (local changes in ${REPO}?)"
  exit 1
fi

build_log="$(mktemp)"
trap 'rm -f "${build_log}"' EXIT

if [[ -n "${deps_changed}" ]]; then
  if ! bun install --frozen-lockfile >"${build_log}" 2>&1; then
    log "bun install failed, not restarting: $(tail -n 20 "${build_log}" | tr '\n' ' ')"
    exit 1
  fi
fi

if ! bun run build >"${build_log}" 2>&1; then
  log "build failed, not restarting: $(tail -n 20 "${build_log}" | tr '\n' ' ')"
  exit 1
fi

# The autodeploy unit runs as `orca`, same as every other step here; only the restart needs
# elevated privilege (deploy/orca-autodeploy.sudoers scopes that to exactly this command).
sudo -n systemctl restart "${SERVICE}"

ok=0
for _ in $(seq 1 30); do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 2 "${BRIDGE_URL}/api/config" 2>/dev/null || echo 000)"
  if [[ "${code}" == "200" ]]; then
    ok=1
    break
  fi
  sleep 1
done

new_head="$(git rev-parse HEAD)"
if [[ "${ok}" -eq 1 ]]; then
  log "deployed ${new_head:0:12}"
else
  log "deployed ${new_head:0:12} but the bridge did not answer /api/config within 30s"
fi
