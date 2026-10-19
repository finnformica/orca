#!/usr/bin/env bash
# Make an Orca box survive memory exhaustion and recover with no human (docs/RECOVERY.md). The
# standard pattern only: protect the critical services, and restart a service that hangs. The
# per-workload limit (orca-agents.slice) is set by the bridge itself, not here.
#
#   sudo deploy/harden.sh            # apply; safe to run again — it changes only what differs
#   deploy/harden.sh --check         # report only: what is missing
#   sudo deploy/harden.sh --undo     # remove every file this script writes (--undo --check: report)
#
# What it sets (each one is skipped when already in place):
#   1. swap: a /swapfile sized to RAM (at most 4 GB), only when the box has no swap at all.
#   2. drop-ins that protect the critical services from the OOM killer:
#      orca.service Restart=always + OOMScoreAdjust=-500; postgresql@.service OOMScoreAdjust=-900;
#      user@<uid of ORCA_USER>.service OOMScoreAdjust=-900 (on 2026-10-18 the OOM killer picked the
#      user manager, and every agent scope failed after that).
#   3. a health watchdog: orca-health.timer runs deploy/health-check.sh (a root-owned copy in
#      /usr/local/lib/orca) every minute. 3 failed /api/config checks in a row restart orca; it
#      skips the first 2 minutes after a start and any deploy in progress. It also restarts a
#      user@<uid>.service that is inactive or failed while lingering is on.
#
# It never restarts orca, postgres or the user manager: the drop-ins apply at their next restart.
# Env: ORCA_USER (default orca), ORCA_SERVICE_NAME (default orca), ORCA_SWAPFILE (default /swapfile),
# ORCA_API_PORT (default: from .env, else 8787).
set -euo pipefail

CHECK=0
UNDO=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --undo) UNDO=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "usage: $0 [--check] [--undo]" >&2; exit 2 ;;
  esac
done

ORCA_USER="${ORCA_USER:-orca}"
SERVICE="${ORCA_SERVICE_NAME:-orca}"
SWAPFILE="${ORCA_SWAPFILE:-/swapfile}"
SWAP_MARK="# orca-harden: the swap file below"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$CHECK" = 0 ] && [ "$(id -u)" != 0 ]; then
  echo "harden.sh: run it with sudo (or use --check to only report)" >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ] || ! command -v systemctl >/dev/null; then
  echo "harden.sh: this is for a Linux box with systemd" >&2
  exit 1
fi

CHANGED=()
MISSING=()
note() { printf '  %-8s %s\n' "$1" "$2"; }
# Something is not in place (or, with --undo, still there). In check mode, record it; otherwise run
# the command and record the change.
fix() { # fix "<what>" <command...>
  local what="$1"; shift
  if [ "$CHECK" = 1 ]; then MISSING+=("$what"); note "$([ "$UNDO" = 1 ] && echo "remove" || echo "missing")" "$what"; return 0; fi
  "$@"
  CHANGED+=("$what"); note "$([ "$UNDO" = 1 ] && echo "removed" || echo "changed")" "$what"
}
ok() { note "ok" "$1"; }
write_file() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

# ---- what this script writes: one list, for apply, --check and --undo ----
uid="$(id -u "$ORCA_USER" 2>/dev/null || true)"
port="${ORCA_API_PORT:-$(sed -n 's/^ORCA_API_PORT=\([0-9][0-9]*\).*/\1/p' "$HERE/../.env" 2>/dev/null | tail -n 1)}"
port="${port:-8787}"
orca_home="$(getent passwd "$ORCA_USER" 2>/dev/null | cut -d: -f6)"
orca_home="${orca_home:-/home/$ORCA_USER}"
HEALTH_BIN=/usr/local/lib/orca/health-check.sh
FILES=(
  "/etc/systemd/system/$SERVICE.service.d/90-orca-harden.conf"
  /etc/systemd/system/postgresql@.service.d/90-orca-harden.conf
  ${uid:+"/etc/systemd/system/user@$uid.service.d/90-orca-harden.conf"}
  "$HEALTH_BIN"
  /etc/systemd/system/orca-health.service
  /etc/systemd/system/orca-health.timer
)
content() { # the content of one file in FILES
  case "$1" in
    */"$SERVICE".service.d/*) printf '[Service]\nRestart=always\nRestartSec=3\nOOMScoreAdjust=-500' ;;
    */postgresql@.service.d/*|*/user@*.service.d/*) printf '[Service]\nOOMScoreAdjust=-900' ;;
    "$HEALTH_BIN") cat "$HERE/health-check.sh" ;;
    */orca-health.service) printf '%s\n' '[Unit]' 'Description=Orca health watchdog (restart a bridge that does not answer)' \
      "After=$SERVICE.service" '' '[Service]' 'Type=oneshot' "Environment=ORCA_SERVICE_NAME=$SERVICE" "Environment=ORCA_USER=$ORCA_USER" \
      "Environment=ORCA_HEALTH_URL=http://127.0.0.1:$port/api/config" "Environment=ORCA_DEPLOY_LOCK=$orca_home/.orca/deploy.lock" "ExecStart=$HEALTH_BIN" ;;
    */orca-health.timer) printf '%s\n' '[Unit]' 'Description=Run the Orca health watchdog every minute' '' \
      '[Timer]' 'OnBootSec=2min' 'OnUnitActiveSec=1min' 'AccuracySec=5s' '' '[Install]' 'WantedBy=timers.target' ;;
  esac
}

# ---- --undo: remove every file this script writes ----
if [ "$UNDO" = 1 ]; then
  echo "harden.sh --undo on $(hostname)$([ "$CHECK" = 1 ] && echo ', check only')"
  if systemctl is-enabled --quiet orca-health.timer 2>/dev/null || systemctl is-active --quiet orca-health.timer 2>/dev/null; then
    fix "disable orca-health.timer" systemctl disable --now orca-health.timer
  fi
  for f in "${FILES[@]}"; do
    if [ -e "$f" ]; then fix "$f" sh -c 'rm -f "$1"; rmdir --ignore-fail-on-non-empty "$(dirname "$1")" 2>/dev/null || true' sh "$f"; fi
  done
  # Only a swap file this script made (its mark is in /etc/fstab).
  if grep -qxF "$SWAP_MARK" /etc/fstab 2>/dev/null; then
    fix "swap file $SWAPFILE and its /etc/fstab lines" sh -c 'swapoff "$1" 2>/dev/null || true; rm -f "$1"; sed -i "\|^$2\$|,+1d" /etc/fstab' sh "$SWAPFILE" "$SWAP_MARK"
  fi
  [ "$CHECK" = 1 ] || systemctl daemon-reload
  echo
  if [ "$CHECK" = 1 ]; then echo "${#MISSING[@]} item(s) to remove. Run: sudo $0 --undo"
  else echo "Removed ${#CHANGED[@]}. The services keep their current settings until their next restart."; fi
  exit 0
fi

mem_mb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
echo "harden.sh on $(hostname) — RAM ${mem_mb} MB$([ "$CHECK" = 1 ] && echo ', check only')"

# ---- 1. swap, only when there is none ----
if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  ok "swap present ($(swapon --show --noheadings --bytes | awk '{s+=$3} END {printf "%d MB", s/1048576}'))"
else
  swap_mb=$(( mem_mb < 4096 ? mem_mb : 4096 ))
  make_swap() {
    [ -f "$SWAPFILE" ] || fallocate -l "${swap_mb}M" "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count="$swap_mb" status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
    swapon "$SWAPFILE"
    grep -qxF "$SWAP_MARK" /etc/fstab || printf '%s\n%s\n' "$SWAP_MARK" "$SWAPFILE none swap sw 0 0" >> /etc/fstab
  }
  fix "swap file $SWAPFILE (${swap_mb} MB), in /etc/fstab" make_swap
fi

# ---- 2 and 3. the drop-ins and the health watchdog ----
[ -n "$uid" ] || note "skipped" "no user $ORCA_USER: no user@<uid>.service drop-in (set ORCA_USER)"
reload=0
for f in "${FILES[@]}"; do
  want="$(content "$f")"
  if [ -f "$f" ] && [ "$(cat "$f")" = "$want" ]; then ok "$f"; continue; fi
  fix "$f" write_file "$f" "$want"
  [ "$CHECK" = 1 ] || { [ "$f" = "$HEALTH_BIN" ] && chmod 755 "$f"; } || true
  reload=1
done
if [ "$reload" = 1 ] && [ "$CHECK" = 0 ]; then systemctl daemon-reload; fi
if systemctl is-enabled --quiet orca-health.timer 2>/dev/null && systemctl is-active --quiet orca-health.timer; then ok "orca-health.timer enabled and running"
else fix "enable orca-health.timer" systemctl enable --now orca-health.timer; fi

echo
if [ "$CHECK" = 1 ]; then
  if [ ${#MISSING[@]} = 0 ]; then echo "Every protection is in place."; else echo "${#MISSING[@]} protection(s) missing. Run: sudo $0"; fi
else
  if [ ${#CHANGED[@]} = 0 ]; then echo "No change: every protection was in place."
  else
    echo "Changed ${#CHANGED[@]}:"; printf '  - %s\n' "${CHANGED[@]}"
    echo "The drop-ins apply at the next restart of $SERVICE, postgres and the user manager. Undo: sudo $0 --undo"
  fi
fi
