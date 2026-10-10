# knowledge-graph user manual

knowledge-graph is a small local server (the *daemon*) plus a web canvas. Your chat client talks to the daemon through MCP; the daemon stores concepts in SQLite and pushes every change live to the canvas in your browser. The server never calls a model: titles and summaries are written by the model you chat with.

## 1. Install and start

You need Node.js 22.18 or newer (`node -v`).

```bash
npx @lucacodastefano/knowledge-graph            # same as: npx @lucacodastefano/knowledge-graph serve
```

Before the first npm release, run it straight from GitHub with `npx --allow-git=all github:lucacodastefano/knowledge-graph` (`--allow-git=all` is needed on npm 11 and later, which refuse git packages by default) (the first run takes a minute: it installs and builds the package). Use the same form in the client configurations below.

The daemon listens on `127.0.0.1:7777` only:

- canvas: http://localhost:7777
- MCP endpoint (Streamable HTTP): http://localhost:7777/mcp
- data: `~/.knowledge-graph/graph.db`

Leave it running in a terminal while you chat. To install the command permanently instead of going through `npx`:

```bash
npm install -g @lucacodastefano/knowledge-graph
knowledge-graph
```

### Commands

| Command | What it does |
|---|---|
| `knowledge-graph` or `knowledge-graph serve` | Start the daemon (canvas + MCP) |
| `knowledge-graph stdio` | stdio bridge for clients without HTTP support; starts the daemon in the background if it is not running |
| `knowledge-graph install-skill` | Copy the Claude Code skill into `~/.claude/skills/knowledge-graph` (honours `CLAUDE_CONFIG_DIR`) |
| `knowledge-graph help` / `version` | Usage / installed version |

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KG_PORT` | `7777` | Port of the daemon (also used by the stdio bridge to find it) |
| `KG_DB` | `~/.knowledge-graph/graph.db` | SQLite file holding everything |

Example: `KG_PORT=8080 KG_DB=~/notes/study.db npx @lucacodastefano/knowledge-graph`. If you change the port, use the same value in your client configuration.

## 2. Connect your model

Any MCP client works. HTTP is the direct route; stdio goes through the bridge. Either way the server sends its tracking rules to the model when the client connects, so no prompt is needed on your side.

### Claude Code

```bash
claude mcp add --transport http knowledge-graph http://localhost:7777/mcp
npx @lucacodastefano/knowledge-graph install-skill
```

Add `--scope user` to the first command to enable it in every project. The skill is optional but recommended: it repeats the tracking and reading rules in the form Claude Code follows most reliably.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`). Add:

```json
{
  "mcpServers": {
    "knowledge-graph": { "command": "npx", "args": ["-y", "@lucacodastefano/knowledge-graph", "stdio"] }
  }
}
```

Restart Claude Desktop. The bridge starts the daemon if needed, so you can open the canvas at http://localhost:7777 right away.

Claude Desktop loads MCP tools only when a chat seems to need them, so on its own it may not start tracking. Add this line once to your personal preferences (Settings → General → "What personal preferences should Claude consider in responses?"):

> In every conversation keep the knowledge graph up to date without mentioning it: kc_start at the first real topic, then kc_track before each answer that explains a concept.

Without it, writing "track this conversation" at the start of a chat works too.

### Gemini CLI

```bash
gemini mcp add --transport http knowledge-graph http://localhost:7777/mcp
```

or in `~/.gemini/settings.json`:

```json
{ "mcpServers": { "knowledge-graph": { "httpUrl": "http://localhost:7777/mcp" } } }
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json` in your workspace, or "MCP: Add Server" from the command palette:

```json
{ "servers": { "knowledge-graph": { "type": "http", "url": "http://localhost:7777/mcp" } } }
```

### Other clients

- Supports Streamable HTTP: point it at `http://localhost:7777/mcp` and start the daemon first.
- stdio only: command `npx`, arguments `-y @lucacodastefano/knowledge-graph stdio`.
- If the model ignores the server instructions, paste the `kc_instructions` prompt (most clients list MCP prompts) at the start of the chat.

## 3. Using it while you chat

Just chat. Before each answer that explains something new, the model adds its concepts to the canvas in one call, then writes the answer. It does not track small talk or clarifications. You can steer it in plain words:

- "track this" / "don't track this";
- "let's go back to *X*": the model moves the current node back to *X* and the next topics hang under it;
- "attach *X* under *Y*": the model moves node *X* (with its children) under *Y* (`kc_move`); merging two names of the same concept is a different tool (`kc_link`);
- "rename *X* to *Z*", "remove *X*", "fix the hierarchy": the model only edits the canvas (`kc_rename`, `kc_remove`, `kc_link`, `kc_move`) and adds no new concepts; removing a node moves its children up to its parent.
- "what have I already studied about *Y*?": the model reads your graph (`kc_recall`) before answering;
- "pick up where we left off": the model reads the outline of the last conversation (`kc_tree`) and continues from the current node;
- "what have I been studying lately?": overview of your graph (`kc_profile`).

The model also checks what you already know before explaining a topic in depth, so it can build on it instead of starting from zero.

## 4. The canvas

The top bar has the search box and two tabs. The interface is in Italian.

### Conversazione (conversation view)

The tree of the conversation: each node is a concept as it came up, children are the drill-downs. The highlighted node is the *current* one, where the next topics will hang.

- A **dashed link** joins two nodes of the same concept: the conversation came back to it.
- **Hover** a node: short summary of what the model said, with **Approfondisci** (open the concept panel) and **Modifica** (edit the node).
- The menu at the top picks the conversation; **Segui l'ultima conversazione** (default) follows whichever conversation is active.

### Grafo personale (personal graph)

Every concept you ever explored, across conversations. Bigger nodes were visited more often; edges join concepts explored one after the other, thicker when it happened more than once. Click a node to open its panel. New concepts appear live without the layout jumping.

### Concept panel

Opened from **Approfondisci**, from the personal graph or from search. It lists every visit of the concept (newest first) with its summary, conversation and date.

## 5. Fixing mistakes

Models get titles wrong sometimes. Every correction is saved at once and shown live in every open canvas.

From the **concept panel**:

| Button | Effect |
|---|---|
| **Rinomina** | Rename the concept; nodes titled with the old name follow. If the new name already belongs to another concept, merge them instead. |
| **Unisci a…** | Merge this concept into another one (pick it by searching): all its visits move there. |
| **Elimina** | Delete the concept and all its nodes from every conversation. |

From **Modifica** on a node (conversation view):

- **Titolo**: rename just this node;
- **Sotto**: move it under another node, or to the root of the conversation (never under one of its own descendants);
- **Concetto**: link the node to a different existing concept;
- **Elimina nodo**: delete just this node.

Deleting a node never loses its children: they move up one level. A concept left with no nodes disappears.

## 6. Search

Type in the search box at the top (**Cerca concetti**). Results come in this order: exact name, names containing the text, then concepts whose titles or summaries mention it. Picking one opens its panel, highlights it in the conversation tree and centres the personal graph on it.

## 7. Your data

- Everything is in one SQLite file (default `~/.knowledge-graph/graph.db`, plus `-wal`/`-shm` files while the daemon runs).
- **Backup**: copy the `.db` file. The daemon folds recent changes into it every 10 seconds and when it stops (Ctrl+C), so the copy is at most a few seconds behind. **Fresh start**: stop the daemon and delete it, or point `KG_DB` at a new file (useful to keep separate graphs per subject).
- The daemon listens on `127.0.0.1` only and rejects cross-site requests to the MCP endpoint and the live socket. Nothing is sent anywhere: the model sees your graph only when it calls a reading tool.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on start | The daemon is already running (open the canvas), or another program uses the port: set `KG_PORT`. |
| Client cannot connect over HTTP | Start the daemon first (`npx @lucacodastefano/knowledge-graph`), and check the port in the URL. |
| Stdio client times out on first start | `npx` was downloading the package; restart the client once. Or install globally and use `"command": "knowledge-graph", "args": ["stdio"]`. |
| Canvas stays empty while chatting | Check the client lists the `kc_*` tools; ask the model to "track this"; for Claude Code install the skill. |
| Wrong or duplicated concepts | Fix them from the canvas (section 5). |
| `node:sqlite` / syntax errors on start | Node is too old: install Node 22.18 or newer. |
