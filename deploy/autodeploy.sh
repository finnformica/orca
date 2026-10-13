#!/usr/bin/env bash
# Auto-deploy: pull main, build, restart — run every minute by orca-autodeploy.timer so the box
# updates itself as soon as main changes (CLAUDE.md "Deploying" → "Auto-deploy"). Idempotent and
# safe to run on a tick with nothing to do.
#
# Busy means EITHER the bridge is mid-orchestrator-wake (GET /api/orchestrator → running:true) OR
# any agent run holds a live lease on this host (~/.orca/leases, honouring ORCA_STATE_DIR — the
# same dir server/lease.ts uses). A worker survives a bridge restart (agent.adoptLeases re-adopts
# its lease), but an orchestrator wake does NOT: systemd killing the process mid-wake looks exactly
# like the orchestrator abandoning its reply (CLAUDE.md "Stability"). So this script defers rather
# than interrupting either kind of in-flight work, and just tries again on the next tick.
#
# A failed build never restarts the service — the old build keeps serving — and logs the tail.
set -euo pipefail

REPO="${ORCA_REPO:-/opt/orca}"
SERVICE="${ORCA_SERVICE_NAME:-orca}"
BRIDGE_URL="${ORCA_BRIDGE_URL:-http://127.0.0.1:8787}"
STATE_DIR="${ORCA_STATE_DIR:-$HOME/.orca}"
LOG="${STATE_DIR}/autodeploy.log"
mkdir -p "${STATE_DIR}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"${LOG}"; }

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

agent_run_live() {
  local dir="${STATE_DIR}/leases" f pid
  [[ -d "${dir}" ]] || return 1
  shopt -s nullglob
  for f in "${dir}"/*.json; do
    pid="$(grep -o '"pid":[0-9]*' "${f}" 2>/dev/null | head -1 | grep -o '[0-9]*')"
    [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null && return 0
  done
  return 1
}

if orchestrator_running || agent_run_live; then
  log "deferred: busy"
  exit 0
fi

if ! git pull --ff-only -q; then
  log "error: git pull --ff-only failed (local changes in ${REPO}?)"
  exit 1
fi

build_log="$(mktemp)"
trap 'rm -f "${build_log}"' EXIT

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
