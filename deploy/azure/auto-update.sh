#!/usr/bin/env bash
# Runs on the VM (root, from a systemd timer): deploys the latest commit of the checked-out branch when it changed.
# The new image is built while the old container keeps serving; a failed build changes nothing and is not retried until the branch moves on.
set -uo pipefail
APP=/opt/kg
STATE=/var/lib/kg-deployed       # last commit that was built and started
FAILED=/var/lib/kg-failed        # last commit whose build failed
LOG=/var/log/kg-autoupdate.log
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

exec 9>/var/lock/kg-autoupdate.lock
flock -n 9 || exit 0             # another run (timer or manual) is in progress

cd "$APP" || exit 1
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch -q --depth 1 origin "$BRANCH" || { say "fetch failed"; exit 1; }
NEW=$(git rev-parse --short=7 FETCH_HEAD)
[ "$NEW" = "$(cat "$STATE" 2>/dev/null)" ] && exit 0
[ "$NEW" = "$(cat "$FAILED" 2>/dev/null)" ] && exit 0

git reset -q --hard FETCH_HEAD
cd deploy/azure
say "deploying $NEW"
if ! docker compose build app >>"$LOG" 2>&1; then
  echo "$NEW" > "$FAILED"; say "build of $NEW FAILED: the previous version keeps running"; exit 1
fi
sed -i '/^KG_COMMIT=/d' .env && echo "KG_COMMIT=$NEW" >> .env
if ! docker compose up -d >>"$LOG" 2>&1; then
  echo "$NEW" > "$FAILED"; say "start of $NEW FAILED"; exit 1
fi
echo "$NEW" > "$STATE"; rm -f "$FAILED"
docker image prune -f >/dev/null 2>&1
say "deployed $NEW"
