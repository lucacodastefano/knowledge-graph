---
name: knowledge-graph
description: Keep the user's knowledge-graph canvas up to date and use what they already know. Use in every conversation where the knowledge-graph MCP tools (kc_*) are available.
---

# knowledge-graph

The knowledge-graph MCP server maps the concepts the user explores with you on a live canvas
(http://localhost:7777) and keeps one graph per chat. Everything you read and write is this chat's graph.

## Writing: one call per answer

1. Call `kc_start` once per chat, when the first real topic comes up, titled with that topic (not "session" or the user's name). Never call it again
   for a new topic: that is a `kc_track` with `parent: "root"`.
   A title always makes a new empty graph. Only when the user asks to continue an earlier graph, pass `resume` (id or title).
2. When your answer will introduce or deepen a concept, call `kc_track` **once**, **before** writing the answer, with all its new nodes; then write the answer once. `kc_start` alone needs no `kc_track`.
   One node per concept you explain: its parts are its children, different aspects of one topic are siblings under it.
   Nodes are concepts, not sections of your answer: when you go deeper into a node already on the canvas, its parts go directly under it.
   Never add a node that restates it ("Aspects of X", "Overview of X", "X" under "X and Y"): the server refuses it.
   - `title`: the concept name, 1-5 words, in the user's language, never a sentence. Same concept = same title;
     tracking it again under the same parent updates it instead of duplicating it.
   - `summary`: 1-2 short sentences saying what the concept is (the node label).
   - `detail`: the full text of your answer about this concept, in markdown (explanations, lists, tables, numbers, examples, caveats),
     as complete as what you write to the user: the graph keeps the same content so they can reread it. Not a summary. Format it to fit the content: tables for comparisons, numbered lists for steps, **bold** for key terms, *italic* for definitions, `##` headings for sub-topics, `>` quotes for warnings, code blocks for code. Fill it for every
     node you explain, and also when you review or expand nodes already on the canvas (track them again with the same title).
   - `parent` (required): the title of the node it belongs under, from the tree that `kc_start` and `kc_track` return;
     `"root"` for an unrelated topic; `"#0"`, `"#1"`... (or its title) to hang a node under another node of the same call, in any order.
   - `excerpt`: leave it out unless a formula or code line is worth keeping as is.
   - `sources`: when your answer uses web search results or documents, put their URLs on the nodes they support (not on every node): one or two primary sources per node; a URL several nodes cite is written once in the call's `sources` and referenced as `"@0"`, `"@1"`. At most 10 nodes per `kc_track` call.
   Every `kc_track` result starts with `Graph: <title>`: if that graph is not this chat's topic, call `kc_start`.
3. "On the canvas" means this chat's graph ("Grafo" in the canvas). To go deeper into a node, `kc_track` its parts with `parent` = that node (no `kc_focus` needed). Use `kc_focus` only to make a node of this graph current again, and `kc_read` with a title to reread a node's full text.
   A parent's `detail` holds only what concerns the whole (introduction, comparison, how the parts connect); each child's content lives only in that child.
4. If `kc_track` reports a `Similar` concept (one of this graph) that is clearly the same idea, call `kc_link` to merge.
5. When the user asks to change the canvas (move, rename, merge, remove, "fix the hierarchy"), use only the editing tools, never `kc_track`:
   `kc_edit` changes part of a node without resending it (replace a fragment of the detail, append text at the end or under a heading, new summary, add or remove a source): use it for corrections and additions, and rewrite a node with `kc_track` only if almost everything changes.
   `kc_move` hangs a node (with its children) under another one or `"root"`; `kc_rename` renames it; `kc_link` merges two names of the same
   concept; `kc_remove` deletes a node and moves its children up, so removing a wrapper node fixes its branch in one call.

Never create nodes about the graph, the tools or the chat itself; do not track small talk, meta questions or clarifications. "Track this" / "don't track this" from the user always wins.

## Reading: this chat's graph

- To check what this graph already says on a topic, call `kc_recall` (a result with `thin: true` is superficial). It never returns anything from other graphs.
- When the user asks to pick up where they left off (after `kc_start` with `resume`), call `kc_tree` (top levels; collapsed branches show `(+N)`), then `kc_tree` with `root` on the branch you need and `kc_read` on the node, and continue from the `*current` node.
- Look in the user's other graphs only when they explicitly ask: `kc_search_graphs` (titles and summaries, grouped by graph), then `kc_read` with `node` and `graph` for a node's text. To bring something into this chat's graph, `kc_track` it in your own words.
- A "↗ Title" node is a reference to another graph: you see only its title. When another graph of the user clearly covers a topic, propose linking it in the chat; call `kc_reference` (`graph`, optional `parent`) only after the user says yes. Never track under a reference.
- `kc_relate` (`concept`, then `superclass` or `related_to`, optional `label`) groups a concept under a superclass (one per concept) or relates two concepts of this graph. Use it only when the user asks to tidy their graph.

## Style

The graph is the user's own knowledge base and they asked for it to be filled, so you need not announce it in every answer; talk about it freely
when asked. If `kc_track` returns an error, nothing was recorded: fix it and call `kc_track` again before answering.
