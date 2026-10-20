#!/usr/bin/env bash
# Local auto-deploy on a Mac (docs/SETUP.md "Local machine"): two LaunchAgents for the user who runs
# this, so the laptop's Orca updates itself like the box does.
#
#   dev.orca.bridge      runs the built bridge (`bun run server/index.ts`) from this checkout, at
#                        login and again whenever it exits (KeepAlive). The SPA is the build in
#                        web/dist — not `bun run dev`, whose file watch restarts the bridge on the
#                        `git pull` itself, before the install and build have passed.
#   dev.orca.autodeploy  runs deploy/autodeploy.sh in launchd mode every 60 s: pull main, install
#                        only when package.json/bun.lock changed, build, then `launchctl kickstart`
#                        the bridge. It skips a checkout that is off main or has uncommitted changes.
#
#   deploy/install-local-autodeploy.sh              install (or reinstall) both and start them
#   deploy/install-local-autodeploy.sh --uninstall  stop both and remove them (logs are kept)
#
# PATH in both agents is the PATH of the shell that runs the installer (launchd's own is only
# /usr/bin:/bin:/usr/sbin:/sbin, which has no bun, gh or claude). Reinstall after you move a tool.
set -euo pipefail

REPO="${ORCA_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
AGENTS_DIR="${ORCA_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
STATE_DIR="${ORCA_STATE_DIR:-$HOME/.orca}"
BRIDGE_LABEL="dev.orca.bridge"
DEPLOY_LABEL="dev.orca.autodeploy"
DOMAIN="gui/$(id -u)"

command -v launchctl >/dev/null || { echo "launchctl not found: this installer is for macOS" >&2; exit 1; }

unload() { launchctl bootout "${DOMAIN}/$1" >/dev/null 2>&1 || true; }

if [[ "${1:-}" == "--uninstall" ]]; then
  for label in "${DEPLOY_LABEL}" "${BRIDGE_LABEL}"; do
    unload "${label}"
    rm -f "${AGENTS_DIR}/${label}.plist"
  done
  echo "Removed ${DEPLOY_LABEL} and ${BRIDGE_LABEL}. Logs stay in ${STATE_DIR}."
  exit 0
fi

BUN="$(command -v bun)" || { echo "bun not found on PATH" >&2; exit 1; }
# The bridge's port: the environment, else the checkout's .env, else the default.
port="${ORCA_API_PORT:-}"
if [[ -z "${port}" && -f "${REPO}/.env" ]]; then
  port="$(sed -n 's/^[[:space:]]*ORCA_API_PORT=\([0-9][0-9]*\).*/\1/p' "${REPO}/.env" | tail -n 1)"
fi
BRIDGE_URL="http://127.0.0.1:${port:-8787}"

mkdir -p "${AGENTS_DIR}" "${STATE_DIR}"

# A first build, so the bridge has an SPA to serve before the first deploy.
(cd "${REPO}" && "${BUN}" install --frozen-lockfile && "${BUN}" run build)

xml() { local s="${1//&/&amp;}"; s="${s//</&lt;}"; printf '%s' "${s//>/&gt;}"; }
env_entry() { printf '    <key>%s</key><string>%s</string>\n' "$1" "$(xml "$2")"; }

cat >"${AGENTS_DIR}/${BRIDGE_LABEL}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BRIDGE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "${BUN}")</string>
    <string>run</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "${REPO}")</string>
  <key>EnvironmentVariables</key>
  <dict>
$(env_entry PATH "${PATH}")
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$(xml "${STATE_DIR}/bridge.log")</string>
  <key>StandardErrorPath</key><string>$(xml "${STATE_DIR}/bridge.log")</string>
</dict>
</plist>
EOF

cat >"${AGENTS_DIR}/${DEPLOY_LABEL}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DEPLOY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml "${REPO}/deploy/autodeploy.sh")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "${REPO}")</string>
  <key>EnvironmentVariables</key>
  <dict>
$(env_entry PATH "${PATH}")
$(env_entry ORCA_REPO "${REPO}")
$(env_entry ORCA_STATE_DIR "${STATE_DIR}")
$(env_entry ORCA_BRIDGE_URL "${BRIDGE_URL}")
$(env_entry ORCA_AUTODEPLOY_MODE launchd)
$(env_entry ORCA_LAUNCHD_LABEL "${BRIDGE_LABEL}")
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$(xml "${STATE_DIR}/autodeploy.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml "${STATE_DIR}/autodeploy.out.log")</string>
</dict>
</plist>
EOF

for label in "${BRIDGE_LABEL}" "${DEPLOY_LABEL}"; do
  unload "${label}"
  launchctl bootstrap "${DOMAIN}" "${AGENTS_DIR}/${label}.plist"
done

echo "Installed ${BRIDGE_LABEL} (${BRIDGE_URL}) and ${DEPLOY_LABEL} (every 60 s)."
echo "Logs: ${STATE_DIR}/bridge.log and ${STATE_DIR}/autodeploy.log"
