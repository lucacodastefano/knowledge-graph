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
   - `summary`: not a summary but your own words: the 1-3 key sentences your answer will say about this concept, exactly as
     you will write them; then use them verbatim in the answer, so the canvas keeps what you actually said.
   - `parent` (required): the title of the node it belongs under, from the tree that `kc_start` and `kc_track` return;
     `"root"` for an unrelated topic; `"#0"`, `"#1"`... (or its title) to hang a node under another node of the same call, in any order.
   - `excerpt`: leave it out unless a formula or code line is worth keeping verbatim.
   - `sources`: when your answer uses web search results or documents, put their URLs on the nodes they support (not on every node).
3. When the conversation goes back to a node already on the canvas, call `kc_focus` with its title instead of tracking it again.
4. If `kc_track` returns `similar` concepts and one is clearly the same idea, call `kc_link` to merge.
5. When the user asks to change the canvas (move, rename, merge, remove, "fix the hierarchy"), use only the editing tools, never `kc_track`:
   `kc_move` hangs a node (with its children) under another one or `"root"`; `kc_rename` renames it; `kc_link` merges two names of the same
   concept; `kc_remove` deletes a node and moves its children up, so removing a wrapper node fixes its branch in one call.

Never create nodes about the graph, the tools or the conversation itself; do not track small talk, meta questions or clarifications. "Track this" / "don't track this" from the user always wins.

## Reading: start from what the user knows

- When a topic first comes up in the conversation (not on follow-ups), call `kc_recall` with the topic. If the user has seen it, build on their notes
  instead of starting from zero, and point out links to earlier topics (`near`) when they help. `sources` lists pages already cited on it.
- When the user asks to pick up where they left off, call `kc_tree` (optionally with `summaries: true`) and continue from the `*current` node.
- When the user asks what they have been studying, or you need context at the start of a session, call `kc_profile`.
- `kc_relate` (`concept`, then `superclass` or `related_to`, optional `label`) groups a concept under a superclass (one per concept) or relates two concepts. Use it after `kc_track` when `kc_recall` shows the topic belongs to an existing group (`in`), or when the user asks to tidy their graph (see `groups` and `ungrouped` in `kc_profile`).

## Style

Tracking is invisible to the user: never announce, promise or confirm it, before or after the answer (no "I recorded this in the graph",
no "I will track every answer"), and never mention the canvas or these tools unless the user asks. If `kc_track` returns an error, nothing
was recorded: fix it and call `kc_track` again before answering. Keep tool arguments short: they cost tokens.
