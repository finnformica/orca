#!/usr/bin/env bash
# The health watchdog (docs/RECOVERY.md): restart a bridge that is alive but does not answer.
# Restart=always does not catch that case, because the process did not exit (Finn's personal box
# after the OOM of 2026-10-18 needed a manual `systemctl restart orca`).
#
# deploy/harden.sh installs a root-owned copy at /usr/local/lib/orca/health-check.sh and runs it
# from orca-health.timer every minute. One run:
#   - skips while orca is not active (Restart=always owns that case), in its first
#     ORCA_HEALTH_GRACE_S seconds after a start (boot or deploy), or while a deploy holds the
#     deploy lock or orca-autodeploy.service runs — each skip clears the count;
#   - curls ORCA_HEALTH_URL with a 10 s timeout; an answer clears the count;
#   - else adds one failure; at ORCA_HEALTH_FAILURES failures in a row it restarts orca.
# Every failure and restart goes to the journal with the tag orca-health.
#
# It also restarts the orca user's systemd manager (user@<uid>.service) when lingering is on and the
# unit is inactive or failed. On 2026-10-18 a memcg OOM killed it; every agent scope failed for 9
# hours after that. This part runs first, and in every case: it does not depend on the bridge.
set -uo pipefail

SERVICE="${ORCA_SERVICE_NAME:-orca}"
# The slotted unit (deploy/orca@.service): restart the slot that is live, not the legacy name.
if [ -z "${ORCA_SERVICE_NAME:-}" ]; then
  for s in orca@a orca@b; do systemctl is-active -q "$s" 2>/dev/null && SERVICE="$s"; done
fi
URL="${ORCA_HEALTH_URL:-http://127.0.0.1:8787/api/config}"
GRACE_S="${ORCA_HEALTH_GRACE_S:-120}"
LIMIT="${ORCA_HEALTH_FAILURES:-3}"
LOCK="${ORCA_DEPLOY_LOCK:-/home/orca/.orca/deploy.lock}"
STATE="${ORCA_HEALTH_STATE:-/run/orca-health}"
UPTIME_FILE="${ORCA_UPTIME_FILE:-/proc/uptime}"
COUNT="$STATE/failures"
ORCA_USER_NAME="${ORCA_USER:-orca}"
LINGER_DIR="${ORCA_LINGER_DIR:-/var/lib/systemd/linger}"

log() { logger -t orca-health -- "$*" 2>/dev/null || echo "orca-health: $*" >&2; }
clear_count() { rm -f "$COUNT"; }
mkdir -p "$STATE"

if [ -e "$LINGER_DIR/$ORCA_USER_NAME" ] && uid="$(id -u "$ORCA_USER_NAME" 2>/dev/null)"; then
  manager="user@$uid.service"
  state="$(systemctl show -p ActiveState --value "$manager" 2>/dev/null)"
  if [ "$state" = inactive ] || [ "$state" = failed ]; then
    log "$manager is $state (lingering is on for $ORCA_USER_NAME): restarting it"
    systemctl restart "$manager" || log "restart of $manager failed"
  fi
fi

if [ "$(systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null)" != active ]; then
  clear_count; exit 0
fi

# Seconds since orca became active, from the unit's monotonic start time and the system uptime.
started_us="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$SERVICE" 2>/dev/null)"
now_us="$(awk '{ printf "%d", $1 * 1000000 }' "$UPTIME_FILE" 2>/dev/null)"
if [[ "$started_us" =~ ^[0-9]+$ ]] && [[ "$now_us" =~ ^[0-9]+$ ]] && [ $(( (now_us - started_us) / 1000000 )) -lt "$GRACE_S" ]; then
  clear_count; exit 0
fi

# A deploy in progress: autodeploy.sh holds the lock for its whole run (a manual deploy can take it
# with `flock <lock> <command>`). Only test a lock file that exists: root must not create it, or the
# orca user cannot open it.
if [ -e "$LOCK" ] && command -v flock >/dev/null && ! flock -n "$LOCK" true 2>/dev/null; then
  clear_count; exit 0
fi
if [ "$(systemctl show -p ActiveState --value orca-autodeploy.service 2>/dev/null)" = activating ]; then
  clear_count; exit 0
fi

if curl -fsS -o /dev/null --max-time 10 "$URL" 2>/dev/null; then
  clear_count; exit 0
fi

n=$(( $(cat "$COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$COUNT"
log "no answer from $URL within 10 s ($n of $LIMIT)"
if [ "$n" -ge "$LIMIT" ]; then
  log "restarting $SERVICE after $n failed checks in a row"
  clear_count
  systemctl restart "$SERVICE"
fi
exit 0
