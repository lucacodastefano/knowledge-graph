# knowledge-graph

A canvas that starts blank and grows a **concept graph while you chat with an LLM**.
The model writes to it through [MCP](https://modelcontextprotocol.io): every new topic becomes a node, every drill-down hangs new nodes under it, and hovering a node shows what the model told you about it.

- **Conversation view**: the path you took, as a tree; concepts you come back to are joined by dashed links.
- **Personal graph** (coming next): every concept you ever explored, across conversations.
- **Model-agnostic**: any MCP client can feed it. Local only, nothing leaves your machine.

> Status: early prototype (conversation view + tracking tools).

## Run it

Requires Node 22.18+.

```bash
git clone https://github.com/lucacodastefano/knowledge-graph && cd knowledge-graph
npm install && npm run build:web
npm start            # canvas on http://localhost:7777, data in ~/.knowledge-graph/graph.db
```

## Connect a model

Claude Code (HTTP):

```bash
claude mcp add --transport http knowledge-graph http://localhost:7777/mcp
```

Clients that only speak stdio (the bridge starts the daemon if needed):

```json
{ "mcpServers": { "knowledge-graph": { "command": "node", "args": ["/path/to/knowledge-graph/src/server/cli.ts", "stdio"] } } }
```

The server sends its tracking instructions to the client automatically; they are also available as the `kc_instructions` prompt.

## Tools

| Tool | Purpose |
|---|---|
| `kc_start` | Start or resume a conversation |
| `kc_track` | Add the concept nodes of an answer (batch) |
| `kc_focus` | Go back to a node already on the canvas |
| `kc_link` | Merge a node into an existing concept |

## Develop

```bash
npm run typecheck && npm test   # unit + MCP over HTTP
npm run test:e2e                # real canvas in headless Chromium, driven by scripts/simulate.ts
```

MIT licensed.
