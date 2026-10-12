#!/usr/bin/env bash
# Creates the Azure VM that hosts knowledge-graph (canvas + MCP over HTTPS). Run once, from Azure Cloud Shell or any `az login`ed shell.
# Usage: deploy.sh [name]   (default: kg-luca; becomes https://<name>.swedencentral.cloudapp.azure.com)
set -euo pipefail
NAME=${1:-kg-luca}
LOCATION=${LOCATION:-swedencentral}   # same region as LocalChat (Italy North has no VM capacity)
# First size that is actually available in the region wins (capacity varies). B1s/B2ats_v2 are free for 12 months on new accounts.
SIZES=${SIZE:-Standard_B1s Standard_B2ats_v2 Standard_B1ms Standard_B2als_v2 Standard_B2s}
BRANCH=${BRANCH:-main}
RG=rg-$NAME
FQDN=$NAME.$LOCATION.cloudapp.azure.com
TOKEN=$(openssl rand -hex 24)
HERE=$(cd "$(dirname "$0")" && pwd)

az group create -n "$RG" -l "$LOCATION" -o none
sed -e "s/__TOKEN__/$TOKEN/" -e "s/__FQDN__/$FQDN/" -e "s/__BRANCH__/$BRANCH/" "$HERE/cloud-init.yaml" > /tmp/kg-cloud-init.yaml
created=
for SIZE in $SIZES; do
  free=$(az vm list-skus -l "$LOCATION" --size "$SIZE" --resource-type virtualMachines --query "[?length(restrictions)==\`0\`].name" -o tsv 2>/dev/null || true)
  [ -n "$free" ] || { echo "skip $SIZE: not available in $LOCATION"; continue; }
  echo "trying $SIZE"
  if az vm create -g "$RG" -n "$NAME" --image Ubuntu2404 --size "$SIZE" --public-ip-address-dns-name "$NAME" \
    --admin-username kg --generate-ssh-keys --custom-data /tmp/kg-cloud-init.yaml --os-disk-size-gb 30 -o none; then created=1; break; fi
done
[ -n "$created" ] || { echo "No VM size available in $LOCATION: retry with LOCATION=northeurope (or westeurope)" >&2; exit 1; }
rm /tmp/kg-cloud-init.yaml
az vm open-port -g "$RG" -n "$NAME" --port 80 --priority 1001 -o none
az vm open-port -g "$RG" -n "$NAME" --port 443 --priority 1002 -o none
# Daily 03:00 UTC auto-shutdown is NOT set: the MCP must stay reachable.

cat <<MSG

Created ($SIZE). The first boot installs and builds for about 5 minutes.
Canvas (opens once, then stays logged in):  https://$FQDN/?token=$TOKEN
Claude connector URL (Settings > Connectors > Add custom connector):  https://$FQDN/t/$TOKEN/mcp
Keep the token secret: it is the only protection. Data lives on the VM disk (Docker volume kgdata).
MSG
