#!/usr/bin/env bash
# Builds knowledge-graph-win-x64.zip from Linux: pinned official Node runtime + app + Go launcher.
# Needs: node/npm, go, curl, unzip, zip. Output: dist-win/knowledge-graph-win-x64.zip
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
NODE_VERSION=${NODE_VERSION:-22.22.0}
work="$root/dist-win"
dir="$work/KnowledgeGraph"
rm -rf "$work"
mkdir -p "$dir/runtime" "$dir/data"

"$root/scripts/stage-portable.sh" "$dir"

# Official Node for Windows, checked against the published SHA-256.
base="https://nodejs.org/dist/v$NODE_VERSION"
zipname="node-v$NODE_VERSION-win-x64.zip"
cache="${KG_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/knowledge-graph}"
mkdir -p "$cache"
[ -f "$cache/$zipname" ] || curl -fsSL "$base/$zipname" -o "$cache/$zipname"
expected=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$zipname" '$2==f{print $1}')
echo "$expected  $cache/$zipname" | sha256sum -c -
unzip -q -j "$cache/$zipname" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$dir/runtime"
mv "$dir/runtime/LICENSE" "$dir/runtime/LICENSE-node.txt"

(cd "$root/launcher" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "$dir/KnowledgeGraph.exe" .)

cp "$root/launcher/LEGGIMI.txt" "$dir/LEGGIMI.txt"
printf '@echo off\r\ncd /d "%%~dp0"\r\nKnowledgeGraph.exe --configura-claude\r\necho.\r\npause\r\n' > "$dir/Configura Claude Desktop.cmd"
printf 'La tua mappa e tutti i dati stanno qui (graph.db). Copia questa cartella per fare un backup.\r\n' > "$dir/data/LEGGIMI.txt"
echo "$(node -p "require('$root/package.json').version")" > "$dir/VERSION.txt"

(cd "$work" && rm -f knowledge-graph-win-x64.zip && zip -qr -9 knowledge-graph-win-x64.zip KnowledgeGraph)
ls -lh "$work/knowledge-graph-win-x64.zip"
