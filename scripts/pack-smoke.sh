#!/usr/bin/env bash
# Packs the package, installs it in an empty folder and checks the daemon serves canvas and MCP.
set -euo pipefail
work=$(mktemp -d)
trap 'kill "${pid:-0}" 2>/dev/null || true; rm -rf "${work:?}"' EXIT
npm pack --silent --pack-destination "$work" >/dev/null
cd "$work"
npm init -y >/dev/null
npm install --silent ./*.tgz
export HOME="$work/home" KG_PORT=7790
npx knowledge-graph version
npx knowledge-graph install-skill
test -f "$HOME/.claude/skills/knowledge-graph/SKILL.md"
./node_modules/.bin/knowledge-graph serve 2>serve.log &
pid=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$KG_PORT/api/health" >/dev/null && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$KG_PORT/" | grep '<div id="root">' >/dev/null
curl -sf -X POST "http://127.0.0.1:$KG_PORT/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | grep '"serverInfo"' >/dev/null
if grep -q Warning serve.log; then cat serve.log; exit 1; fi
echo "pack smoke test passed"
