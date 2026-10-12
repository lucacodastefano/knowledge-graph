#!/usr/bin/env bash
# Pulls the latest main on the VM and rebuilds. Usage: update.sh [name]
set -euo pipefail
NAME=${1:-kg-luca}
az vm run-command invoke -g "rg-$NAME" -n "$NAME" --command-id RunShellScript \
  --scripts 'cd /opt/kg && git pull -q && cd deploy/azure && docker compose up -d --build' --query 'value[0].message' -o tsv
