#!/usr/bin/env bash
# Creates the Azure VM that hosts knowledge-graph (canvas + MCP over HTTPS). Run once, from Azure Cloud Shell or any `az login`ed shell.
# Usage: deploy.sh [name]   (default: kg-luca; becomes https://<name>.<region>.cloudapp.azure.com)
# Only the sizes of Azure's 12-month free offer (750 h/month: B1s, B2pts v2, B2ats v2) are tried, in several regions.
# A paid size is used only with ALLOW_PAID=1 (about EUR 8-10/month), and the script says so.
set -euo pipefail
NAME=${1:-kg-luca}
BRANCH=${BRANCH:-main}
REGIONS=${REGIONS:-swedencentral northeurope westeurope francecentral germanywestcentral}
SIZES="Standard_B1s Standard_B2ats_v2 Standard_B2pts_v2"
[ "${ALLOW_PAID:-0}" = 1 ] && SIZES="$SIZES Standard_B1ms Standard_B2als_v2 Standard_B2s"
RG=rg-$NAME
TOKEN=$(openssl rand -hex 24)
HERE=$(cd "$(dirname "$0")" && pwd)
created=

for LOCATION in $REGIONS; do
  for SIZE in $SIZES; do
    free=$(az vm list-skus -l "$LOCATION" --size "$SIZE" --resource-type virtualMachines --query "[?length(restrictions)==\`0\`].name" -o tsv 2>/dev/null || true)
    [ -n "$free" ] || { echo "skip $SIZE in $LOCATION: not available"; continue; }
    # B2pts v2 is an Arm machine.
    IMAGE=Ubuntu2404; [ "$SIZE" = Standard_B2pts_v2 ] && IMAGE=Canonical:ubuntu-24_04-lts:server-arm64:latest
    case $SIZE in Standard_B1s|Standard_B2ats_v2|Standard_B2pts_v2) ;; *) echo "WARNING: $SIZE is NOT in the free offer: it costs money (about EUR 8-10/month)";; esac
    echo "trying $SIZE in $LOCATION"
    FQDN=$NAME.$LOCATION.cloudapp.azure.com
    sed -e "s/__TOKEN__/$TOKEN/" -e "s/__FQDN__/$FQDN/" -e "s/__BRANCH__/$BRANCH/" "$HERE/cloud-init.yaml" > /tmp/kg-cloud-init.yaml
    az group create -n "$RG" -l "$LOCATION" -o none
    if az vm create -g "$RG" -n "$NAME" --image "$IMAGE" --size "$SIZE" --public-ip-address-dns-name "$NAME" \
      --admin-username kg --generate-ssh-keys --custom-data /tmp/kg-cloud-init.yaml --os-disk-size-gb 30 -o none; then created=1; break 2; fi
    az group delete -n "$RG" --yes -o none   # empty after a failed create: start clean in the next region
  done
done
rm -f /tmp/kg-cloud-init.yaml
[ -n "$created" ] || { echo "No free-offer size available in: $REGIONS. Nothing was created. ALLOW_PAID=1 would also try paid sizes." >&2; exit 1; }
az vm open-port -g "$RG" -n "$NAME" --port 80 --priority 1001 -o none
az vm open-port -g "$RG" -n "$NAME" --port 443 --priority 1002 -o none

cat <<MSG

Created ($SIZE in $LOCATION). The first boot installs and builds for about 5 minutes.
Canvas (opens once, then stays logged in):  https://$FQDN/?token=$TOKEN
Claude connector URL (Settings > Connectors > Add custom connector):  https://$FQDN/t/$TOKEN/mcp
Keep the token secret: it is the only protection. Data lives on the VM disk (Docker volume kgdata).
The free offer applies to new Azure accounts only; set a budget alert in the portal. Delete everything: az group delete -n $RG
MSG
