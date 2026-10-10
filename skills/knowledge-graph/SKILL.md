---
name: knowledge-graph
description: Keep the user's knowledge-graph canvas up to date and use what they already know. Use in every conversation where the knowledge-graph MCP tools (kc_*) are available.
---

# knowledge-graph

The knowledge-graph MCP server maps the concepts the user explores with you on a live canvas
(http://localhost:7777) and remembers them across conversations. You write to it and read from it.

## Writing: one call per answer

1. Call `kc_start` once per chat, when the first real topic comes up, with a short title. Never call it again
   for a new topic: that is a `kc_track` with `parent: "root"`.
   To continue an earlier conversation pass `resume` with its id (find it with `kc_profile`).
2. After each answer that introduces or deepens a concept, call `kc_track` **once** with all the new nodes of that answer:
   - `title`: the concept name, 1-5 words, in the user's language, never a sentence. Same concept = same title.
   - `summary`: 1-3 sentences of what you actually explained, so the user can recall it later.
   - `parent`: `"current"` (default) to go deeper, `"root"` for an unrelated topic, a node id from earlier results for any other
     node (e.g. a sibling of the current one; no `kc_focus` needed), `"#0"`, `"#1"`... to hang a node under an earlier node of the same call.
   - `excerpt`: leave it out unless a formula or code line is worth keeping verbatim.
3. When the conversation goes back to a node already on the canvas, call `kc_focus` with its id instead of tracking it again.
4. If `kc_track` returns `similar` concepts and one is clearly the same idea, call `kc_link` to merge.

Do not track small talk, meta questions or clarifications. "Track this" / "don't track this" from the user always wins.

## Reading: start from what the user knows

- When a topic first comes up in the conversation (not on follow-ups), call `kc_recall` with the topic. If the user has seen it, build on their notes
  instead of starting from zero, and point out links to earlier topics (`near`) when they help.
- When the user asks to pick up where they left off, call `kc_tree` (optionally with `summaries: true`) and continue from the `*current` node.
- When the user asks what they have been studying, or you need context at the start of a session, call `kc_profile`.

## Style

Never mention these tool calls to the user unless they ask. Keep tool arguments short: they cost tokens.
