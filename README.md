# knowledge-graph

A canvas that starts blank and grows a **concept graph while you chat with an LLM**.
The model writes to it through [MCP](https://modelcontextprotocol.io): every new topic becomes a node, every drill-down hangs new nodes under it, and hovering a node shows what the model told you about it.

- **Conversation view**: the path you took, as a tree; concepts you come back to are joined by dashed links.
- **Personal graph**: every concept you ever explored, across all conversations.
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

## Tools the model gets

| Tool | Purpose |
|---|---|
| `kc_start` | Start or resume a conversation |
| `kc_track` | Add the concept nodes of an answer (batch) |
| `kc_focus` | Go back to a node already on the canvas |
| `kc_link` | Merge a node into an existing concept |
| `kc_move` | Move a node under another node |
| `kc_rename` | Rename a node |
| `kc_remove` | Remove a node; its children move up |
| `kc_recall` | What the user already explored about a topic |
| `kc_tree` | Outline of a conversation |
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
