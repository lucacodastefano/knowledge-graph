#!/usr/bin/env bash
# Linux check of the portable layout: same folder structure as the Windows zip, host Node instead of node.exe.
# Run after scripts/package-win.sh (reuses its staged app). Checks launcher, data folder, "already running", config script.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap '[ -z "${pid:-}" ] || kill "$pid" 2>/dev/null || true; rm -rf "${work:?}"' EXIT
stage="$root/dist-win/KnowledgeGraph"
test -d "$stage/app" || { echo "run scripts/package-win.sh first" >&2; exit 1; }
dir="$work/KnowledgeGraph"
mkdir -p "$dir/runtime"
cp -r "$stage/app" "$dir/app"
ln -s "$(command -v node)" "$dir/runtime/node"
(cd "$root/launcher" && go build -o "$dir/KnowledgeGraph" .)
export KG_PORT=7791 PATH="$work/bin:$PATH"
mkdir -p "$work/bin" && printf '#!/bin/sh\ntouch "%s/opened"\n' "$work" > "$work/bin/xdg-open" && chmod +x "$work/bin/xdg-open"
"$dir/KnowledgeGraph" >"$work/launcher.log" 2>&1 &
pid=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$KG_PORT/api/health" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$KG_PORT/" | grep '<div id="root">' >/dev/null
test -f "$dir/data/graph.db"
sleep 0.5; test -f "$work/opened"; rm "$work/opened"
"$dir/KnowledgeGraph" | grep -q "già in esecuzione"; sleep 0.5; test -f "$work/opened"
"$dir/KnowledgeGraph" --ferma | grep -q fermato
wait "$pid"
pid=
# Claude Desktop config: existing servers untouched, entry points at the folder's runtime and data.
echo '{"mcpServers":{"other":{"command":"x"}}}' > "$work/cfg.json"
env -u KG_DB "$dir/runtime/node" "$dir/app/dist/server/cli.js" configure-claude --db "$dir/data/graph.db" --config "$work/cfg.json" 2>&1
node -e "
const c=JSON.parse(require('fs').readFileSync('$work/cfg.json','utf8'));
const e=c.mcpServers['knowledge-graph'];
if(!c.mcpServers.other||!e.command.endsWith('/node')||e.env.KG_DB!=='$dir/data/graph.db')process.exit(1);"
ls "$work"/cfg.json.bak-* >/dev/null
echo "portable smoke test passed"
