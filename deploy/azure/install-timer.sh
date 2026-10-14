#!/usr/bin/env bash
# Runs on the VM (root): installs or refreshes the systemd timer that runs auto-update.sh every 5 minutes.
set -euo pipefail
chmod +x /opt/kg/deploy/azure/auto-update.sh
cat > /etc/systemd/system/kg-autoupdate.service <<UNIT
[Unit]
Description=Deploy the latest knowledge-graph commit
[Service]
Type=oneshot
ExecStart=/opt/kg/deploy/azure/auto-update.sh
UNIT
cat > /etc/systemd/system/kg-autoupdate.timer <<UNIT
[Unit]
Description=Check for a new knowledge-graph commit every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now kg-autoupdate.timer
