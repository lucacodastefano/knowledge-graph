#!/usr/bin/env bash
# Stages the app part of the portable folder: built server + canvas, production dependencies only (no native ones).
# Usage: stage-portable.sh <target-dir>   (creates <target-dir>/app)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=$1/app
rm -rf "$out"
mkdir -p "$out"
(cd "$root" && npm run build --silent)
cp -r "$root/dist" "$root/web" "$out/"
rm -rf "$out/web/node_modules" "$out"/web/src "$out"/web/*.ts "$out"/web/*.html "$out"/web/*.json 2>/dev/null || true
cp -r "$root/skills" "$out/"
cp "$root/package.json" "$root/package-lock.json" "$root/LICENSE" "$out/"
(cd "$out" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
rm -f "$out/package-lock.json"
# Native addons would need Windows binaries: there must be none.
if find "$out/node_modules" -name '*.node' | grep -q .; then
  echo "native addons found in production dependencies:" >&2
  find "$out/node_modules" -name '*.node' >&2
  exit 1
fi
