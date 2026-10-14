#!/usr/bin/env bash
# Deploys the latest main now, and installs/refreshes the VM's auto-update timer (after that, merges go live by themselves within ~5 minutes). Usage: update.sh [name]
set -euo pipefail
NAME=${1:-kg-luca}
az vm run-command invoke -g "rg-$NAME" -n "$NAME" --command-id RunShellScript \
  --scripts 'cd /opt/kg && git pull -q && bash deploy/azure/install-timer.sh && bash deploy/azure/auto-update.sh; echo "live: $(cat /var/lib/kg-deployed)"; systemctl is-active kg-autoupdate.timer' --query 'value[0].message' -o tsv
