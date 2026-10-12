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
[ -f .env ] || cat > .env <<ENV
ORCA_DEV_ROOT=/opt
ORCA_INSTANCE=cloud
ORCA_BIND=$ts_ip
ORCA_PREVIEW_HOST=$ts_name
ORCA_DATABASE_URL=postgres://orca:orca@localhost:5432/orca
ORCA_TEST_DATABASE_URL=postgres://orca:orca@localhost:5432/postgres
ENV
sudo cp deploy/orca.service /etc/systemd/system/orca.service
sudo systemctl daemon-reload && sudo systemctl enable --now orca
echo "orca → http://$ts_name:8787  (database: postgres://orca:orca@$ts_name:5432/orca for the laptop's ORCA_DATABASE_URL)"
