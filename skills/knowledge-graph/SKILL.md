---
name: knowledge-graph
description: Keep the user's knowledge-graph canvas up to date and use what they already know. Use in every conversation where the knowledge-graph MCP tools (kc_*) are available.
---

# knowledge-graph

The knowledge-graph MCP server maps the concepts the user explores with you on a live canvas
(http://localhost:7777) and remembers them across conversations. You write to it and read from it.

## Writing: one call per answer

1. Call `kc_start` once per chat, when the first real topic comes up, titled with that topic (not "session" or the user's name). Never call it again
   for a new topic: that is a `kc_track` with `parent: "root"`.
   To continue an earlier conversation pass `resume` with its id (find it with `kc_profile`).
2. When your answer will introduce or deepen a concept, call `kc_track` **once**, **before** writing the answer, with all its new nodes; then write the answer once. `kc_start` alone needs no `kc_track`.
   One node per concept you explain: its parts are its children, different aspects of one topic are siblings under it.
   Nodes are concepts, not sections of your answer: when you go deeper into a node already on the canvas, its parts go directly under it.
   Never add a node that restates it ("Aspects of X", "Overview of X", "X" under "X and Y"): the server refuses it.
   - `title`: the concept name, 1-5 words, in the user's language, never a sentence. Same concept = same title;
     tracking it again under the same parent updates it instead of duplicating it.
   - `summary`: 1-2 short sentences saying what the concept is (the node label).
   - `detail`: the full text of your answer about this concept, in markdown (explanations, lists, tables, numbers, examples, caveats),
     as complete as what you write to the user: the map keeps the same content so they can reread it. Not a summary. Format it to fit the content: tables for comparisons, numbered lists for steps, **bold** for key terms, *italic* for definitions, `##` headings for sub-topics, `>` quotes for warnings, code blocks for code. Fill it for every
     node you explain, and also when you review or expand nodes already on the canvas (track them again with the same title).
   - `parent` (required): the title of the node it belongs under, from the tree that `kc_start` and `kc_track` return;
     `"root"` for an unrelated topic; `"#0"`, `"#1"`... (or its title) to hang a node under another node of the same call, in any order.
   - `excerpt`: leave it out unless a formula or code line is worth keeping as is.
   - `sources`: when your answer uses web search results or documents, put their URLs on the nodes they support (not on every node).
3. "On the canvas" means this conversation's map. To go deeper into a node, `kc_track` its parts with `parent` = that node (no `kc_focus` needed); a concept that is only in the user's graph is tracked here, not focused. Use `kc_focus` only to make a node of this map current again, and `kc_read` with a title to reread a node's full text.
   A parent's `detail` holds only what concerns the whole (introduction, comparison, how the parts connect); each child's content lives only in that child.
4. If `kc_track` reports a `Similar` concept that is clearly the same idea, call `kc_link` to merge.
5. When the user asks to change the canvas (move, rename, merge, remove, "fix the hierarchy"), use only the editing tools, never `kc_track`:
   `kc_move` hangs a node (with its children) under another one or `"root"`; `kc_rename` renames it; `kc_link` merges two names of the same
   concept; `kc_remove` deletes a node and moves its children up, so removing a wrapper node fixes its branch in one call.

Never create nodes about the graph, the tools or the conversation itself; do not track small talk, meta questions or clarifications. "Track this" / "don't track this" from the user always wins.

## Reading: start from what the user knows

- When a topic first comes up in the conversation (not on follow-ups), call `kc_recall` with the topic. If the user has seen it, build on their notes
  instead of starting from zero, and point out links to earlier topics (`near`) when they help. `sources` lists pages already cited on it.
- When the user asks to pick up where they left off, call `kc_tree` (optionally with `summaries: true`) and continue from the `*current` node.
- When the user asks what they know or what is missing on a topic, read `kc_recall` (a result with `thin: true` is superficial) or `kc_profile` and answer from it.
- When the user asks what they have been studying, or you need context at the start of a session, call `kc_profile`.
- `kc_relate` (`concept`, then `superclass` or `related_to`, optional `label`) groups a concept under a superclass (one per concept) or relates two concepts. Use it after `kc_track` when `kc_recall` shows the topic belongs to an existing group (`in`), or when the user asks to tidy their graph (see `groups` and `ungrouped` in `kc_profile`).

## Style

The map is the user's own knowledge base and they asked for it to be filled, so you need not announce it in every answer; talk about it freely
when asked. If `kc_track` returns an error, nothing was recorded: fix it and call `kc_track` again before answering.
