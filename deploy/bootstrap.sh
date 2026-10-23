#!/usr/bin/env bash
# Run ONCE on the box as `orca`, after `gh auth login` and `git clone <orca> /opt/orca`: build,
# write .env for a tailnet-bound cloud instance, install and start the systemd unit.
set -euo pipefail
cd /opt/orca
ts_ip=$(tailscale ip -4)
ts_name=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun install --frozen-lockfile
bun run build

# Per-run memory ceiling (server/cgroup.ts): `systemd-run --user --scope` needs a user manager +
# bus, which `orca` — a service account that never logs in interactively — has none of by default.
# Lingering starts one at boot regardless, and persists across reboots. Without this, every agent
# run still works; it just isn't memory-capped (cgroup.available() sees no bus and no-ops).
sudo loginctl enable-linger orca
[ -f .env ] || cat > .env <<ENV
ORCA_DEV_ROOT=/opt
ORCA_INSTANCE=cloud
# Loopback AS WELL: an Orca preview on the box (Vite proxies /api to localhost:8787) and bin/orca
# both reach the bridge there.
ORCA_BIND=127.0.0.1,$ts_ip
ORCA_PREVIEW_HOST=$ts_name
ORCA_DATABASE_URL=postgres://orca:orca@localhost:5432/orca
ORCA_TEST_DATABASE_URL=postgres://orca:orca@localhost:5432/postgres
# Deploys start the new bridge beside the old one on 8787 (deploy/orca@.service, deploy/autodeploy.sh).
ORCA_REUSE_PORT=1
ENV
sudo cp deploy/orca@.service /etc/systemd/system/orca@.service
sudo systemctl daemon-reload && sudo systemctl enable --now orca@a

# Auto-deploy: pulls main, builds and restarts the bridge on its own once main changes (see
# CLAUDE.md "Deploying" → "Auto-deploy").
sudo cp deploy/orca-autodeploy.service deploy/orca-autodeploy.timer /etc/systemd/system/
sudo cp deploy/orca-autodeploy.sudoers /etc/sudoers.d/orca-autodeploy
sudo chmod 440 /etc/sudoers.d/orca-autodeploy
sudo visudo -c
sudo systemctl daemon-reload && sudo systemctl enable --now orca-autodeploy.timer

echo "orca → http://$ts_name:8787  (database: postgres://orca:orca@$ts_name:5432/orca for the laptop's ORCA_DATABASE_URL)"
