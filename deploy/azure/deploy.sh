#!/usr/bin/env bash
# Creates the Azure VM that hosts knowledge-graph (canvas + MCP over HTTPS). Run once, from Azure Cloud Shell or any `az login`ed shell.
# Usage: deploy.sh [name]   (default: kg-luca; becomes https://<name>.swedencentral.cloudapp.azure.com)
set -euo pipefail
NAME=${1:-kg-luca}
LOCATION=${LOCATION:-swedencentral}   # same region as LocalChat (Italy North has no VM capacity)
SIZE=${SIZE:-Standard_B1s}            # free for 12 months on new Azure accounts (750 h/month), ~EUR 8/month afterwards
BRANCH=${BRANCH:-main}
RG=rg-$NAME
FQDN=$NAME.$LOCATION.cloudapp.azure.com
TOKEN=$(openssl rand -hex 24)
HERE=$(cd "$(dirname "$0")" && pwd)

az group create -n "$RG" -l "$LOCATION" -o none
sed -e "s/__TOKEN__/$TOKEN/" -e "s/__FQDN__/$FQDN/" -e "s/__BRANCH__/$BRANCH/" "$HERE/cloud-init.yaml" > /tmp/kg-cloud-init.yaml
az vm create -g "$RG" -n "$NAME" --image Ubuntu2404 --size "$SIZE" --public-ip-address-dns-name "$NAME" \
  --admin-username kg --generate-ssh-keys --custom-data /tmp/kg-cloud-init.yaml --os-disk-size-gb 30 -o none
rm /tmp/kg-cloud-init.yaml
az vm open-port -g "$RG" -n "$NAME" --port 80 --priority 1001 -o none
az vm open-port -g "$RG" -n "$NAME" --port 443 --priority 1002 -o none
# Daily 03:00 UTC auto-shutdown is NOT set: the MCP must stay reachable.

cat <<MSG

Created. The first boot installs and builds for about 5 minutes.
Canvas (opens once, then stays logged in):  https://$FQDN/?token=$TOKEN
Claude connector URL (Settings > Connectors > Add custom connector):  https://$FQDN/t/$TOKEN/mcp
Keep the token secret: it is the only protection. Data lives on the VM disk (Docker volume kgdata).
MSG
