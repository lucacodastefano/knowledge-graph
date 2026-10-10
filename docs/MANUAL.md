# knowledge-graph user manual

knowledge-graph is a small local server (the *daemon*) plus a web canvas. Your chat client talks to the daemon through MCP; the daemon stores concepts in SQLite and pushes every change live to the canvas in your browser. The server never calls a model: titles and texts are written by the model you chat with, and each node keeps the key sentences of the answer as the model wrote them, not a summary.

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
| `knowledge-graph stdio` | stdio bridge for clients without HTTP support; starts the daemon in the background if it is not running, and replaces a running daemon of an older version (e.g. after an update) |
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

> Use the knowledge-graph tools silently in every conversation: kc_start at the first real topic, then kc_track before writing each answer that explains a concept. Never tell me about them.

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

- A **dashed link** joins two nodes of the same concept: the conversation came back to it, possibly from another branch. Such nodes also show **anche in: …** with the other places.
- **Hover** a node for a moment: the node's text (the key sentences of the answer) appears beside it, with **Approfondisci** (open the concept panel). It closes as soon as you move to another node; **Esc** closes it too.
- A small **number** in a node's corner counts the sources (web pages, documents) the model cited for it; open **Approfondisci** to see them.
- **Relations at a glance**: pointing at a node highlights its parent, its children and the other nodes of the same concept (with the dashed links to them), and fades everything else. **Click** a node to keep the highlight while you move around; click it again, click an empty spot of the canvas or press **Esc** to clear it.
- The menu at the top picks the conversation; **Segui l'ultima conversazione** (default) follows whichever conversation is active.
- The second menu picks the layout, remembered by the browser: **Radiale** (default: the first topic in the middle, each level on a wider ring), **Mappa mentale** (the topic in the middle, branches to the right and to the left, split so both halves are about as tall; a branch changes side only when that clearly improves the balance) or **Albero** (left to right). The bottom-left button fits the whole tree on screen.

### Grafo personale (personal graph)

Every concept you ever explored, across conversations. Bigger nodes were visited more often; edges join concepts explored one after the other, thicker when it happened more than once. Click a node to open its panel. New concepts appear live without the layout jumping.

- **Levels.** From afar each community (concepts that link mostly among themselves, found with Louvain) is a bubble named after its hub, with its concept count; concepts with no link at all sit together in **Concetti isolati**. Click a bubble or zoom in to see the single concepts. The layout keeps communities apart; **Riordina** recomputes communities and layout.
- **Labels.** Only the bigger concepts and those near the pointer get a label, and labels never overlap each other or a peer's dot; hover a node to read any name.
- **Colour.** **Colora per** colours by community or by conversation (a concept takes the colour of the conversation where it appears most). The legend (collapsible) lists the groups with their counts; click an entry to highlight that group.
- **Filters.** By conversation, by period (last seen), **Nascondi isolati** and **Solo concetti con fonti** (only concepts whose answers cited at least one source). The counter shows how many concepts are left and the view fits them. The colouring, the isolated toggle and the legend state are remembered; the other filters are not.

### Concept panel

Opened from **Approfondisci**, from the personal graph or from search. It lists every place the concept appears (newest first): conversation, the node it sits under, date and the text from the answer, followed by its sub-concepts as sections (two levels), which is where the real depth of an explanation lives.

**Dettaglio approfondito** (checkbox in the top bar, off by default): when on, the model also keeps the 5-10 key points of its answer, worded as in the answer, for a node it goes deep on, shown as a list in the panel. It costs some output tokens on those answers; when off, the model is not even told the option exists. The change applies at once, also to chats already open and without restarting the client: the daemon re-announces its tools and tells the model in the result of its next `kc_start` or `kc_track`.

**Fonti**: when an answer relies on web search results or documents, the model attaches their links to the nodes, and the panel lists them once per page (without tracking parameters). In edit mode each source has a ✕ to remove a wrong one.

## 5. Fixing mistakes

Models get titles wrong sometimes. Every correction is saved at once and shown live in every open canvas.

Everything happens in the **concept panel**. The pencil (**✎**) makes its texts editable in place: the concept name (nodes titled with the old name follow; a name that already belongs to another concept must be merged instead), every node text and key point, the section titles, and for each place **sotto** (move it under another node or to the root, never under its own descendants). **Elimina questo nodo** removes just that node. **Salva** applies everything, **Annulla** drops it. Every save keeps the previous texts in the database, for a future version history.

The **⋯** menu has **Unisci a…** (merge this concept into another one, picked by searching: all its places move there) and **Elimina concetto** (delete the concept and all its nodes from every conversation).

You can also ask the model in the chat: "rename X", "remove X", "fix the hierarchy" (see §3).

Deleting a node never loses its children: they move up one level. A concept left with no nodes disappears.

## 6. Search

Type in the search box at the top (**Cerca concetti**). Results come in this order: exact name, names containing the text, then concepts whose titles or texts mention it. Picking one opens its panel, highlights it in the conversation tree and centres the personal graph on it.

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
| Old behaviour after an update | The stdio bridge replaces an older daemon by itself when the client restarts. A daemon you started by hand (`serve`) must be stopped by hand (Ctrl+C). |
| The model says "I recorded this in the graph" | It should not: update to the latest version and use the preferences line in section 2. |
| `node:sqlite` / syntax errors on start | Node is too old: install Node 22.18 or newer. |
