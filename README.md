# knowledge-graph

A canvas that starts blank and grows a **concept graph while you chat with an LLM**.
The model writes to it through [MCP](https://modelcontextprotocol.io): every new topic becomes a node, every drill-down hangs new nodes under it, and hovering a node shows what the model told you about it.

- **Graph**: the path you took, as a tree; concepts you come back to are joined by dashed links.
- **Global graph**: every concept you ever explored, across all graphs.
- **The model remembers**: before explaining a topic it can check what you already know and build on it.
- **Model-agnostic and local**: any MCP client can feed it; data stays in one SQLite file on your machine. No API keys, no telemetry.

## Quick start

Requires [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npx @lucacodastefano/knowledge-graph
```

> Not on npm yet? Use `npx --allow-git=all github:lucacodastefano/knowledge-graph` wherever this page says `npx @lucacodastefano/knowledge-graph`: it builds the package from GitHub on first run.

Open http://localhost:7777, then connect your model. For Claude Code:

```bash
claude mcp add --transport http knowledge-graph http://localhost:7777/mcp
npx @lucacodastefano/knowledge-graph install-skill   # optional: tracking rules as a Claude Code skill
```

Start chatting: the canvas fills up as you go.

For Claude Desktop and clients that only speak stdio, add this to the client's MCP configuration (the bridge starts the daemon for you):

```json
{ "mcpServers": { "knowledge-graph": { "command": "npx", "args": ["-y", "@lucacodastefano/knowledge-graph", "stdio"] } } }
```

The **[user manual](docs/MANUAL.md)** covers every client (Claude Code, Claude Desktop, Gemini CLI, VS Code, others), the canvas, corrections, search, configuration and backups.

## Windows portable version

No install, no Node.js needed: a folder you unzip and run.

1. Download `knowledge-graph-win-x64.zip` from the [latest release](https://github.com/lucacodastefano/knowledge-graph/releases/latest) and extract the whole folder (anywhere, even a USB stick).
2. Double-click `KnowledgeGraph.exe`: a console window starts the server and your browser opens http://localhost:7777. Close the window to stop it. The executable is not code-signed, so Windows may show "Windows protected your PC": choose *More info* → *Run anyway*.
3. For Claude Desktop, double-click `Configura Claude Desktop.cmd`, then quit Claude Desktop completely (tray icon → Quit) and reopen it. The script backs up `claude_desktop_config.json` and only adds or updates the `knowledge-graph` entry.

Everything you create lives in `data\graph.db` inside the folder, so moving the folder moves your graphs (run the configure script again after moving it). To **update**, extract the new zip and copy your old `data\` folder into it. To **keep an existing database**, close the app and copy your `graph.db` (normally `C:\Users\<you>\.knowledge-graph\`) over `data\graph.db`. `KnowledgeGraph.exe --ferma` stops a server started in the background by Claude Desktop.

Build it yourself from Linux or macOS with `npm run package:win` (needs Go and curl; downloads the pinned official Node.js for Windows and verifies its checksum).

## Tools the model gets

| Tool | Purpose |
|---|---|
| `kc_start` | Start a graph, or resume one (same title, `resume`, similar graphs offered) |
| `kc_track` | Add the concept nodes of an answer (batch) |
| `kc_edit` | Change part of a node (replace, append, summary, sources) without resending it |
| `kc_focus` | Go back to a node already on the canvas |
| `kc_link` | Merge a node into an existing concept |
| `kc_move` | Move a node under another node |
| `kc_rename` | Rename a node |
| `kc_remove` | Remove a node; its children move up |
| `kc_recall` | What the user already explored about a topic |
| `kc_tree` | Outline of a graph, with its relations |
| `kc_read` | Full text of one node, with its children's titles |
| `kc_profile` | Overview of the user's knowledge |

The server sends its tracking instructions to the client automatically; they are also available as the `kc_instructions` prompt.

## Develop

```bash
git clone https://github.com/lucacodastefano/knowledge-graph && cd knowledge-graph
npm install
npm start                       # daemon from source on :7777 (run `npm run build:web` once for the canvas)
npm run dev:web                 # canvas with hot reload, proxied to the daemon
npm run typecheck && npm test   # unit + MCP over HTTP
npm run test:e2e                # real canvas in headless Chromium
npm run build                   # what gets published: dist/ (server) + web/dist/ (canvas)
```

Architecture and decisions (Italian): [docs/ARCHITETTURA.md](docs/ARCHITETTURA.md).

MIT licensed.
