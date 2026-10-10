/**
 * Model-agnostic tracking rules (D6), served as the MCP server `instructions`
 * and as the `kc_instructions` prompt. Kept short: it is sent with every session.
 */
export const TRACKING_INSTRUCTIONS = `You are connected to knowledge-graph, a canvas that maps the concepts the user explores with you.

Rules:
- At the start of a conversation call kc_start once (pass a short title if the topic is clear).
- After each answer that introduces or deepens a concept, call kc_track ONCE with all new nodes of that answer.
  - New topic unrelated to the current one: parent "root".
  - Going deeper into the current topic: parent "current" (default).
  - Several nodes in one answer: use "#0", "#1"... to hang a node under an earlier node of the same call.
- Title: the concept name, 1-5 words, in the user's language, no sentence. Same concept = same title.
- Summary: 1-3 sentences of what you actually explained, written so the user can recall it later.
- When the conversation returns to a node already on the canvas, call kc_focus with its id instead of creating it again.
- If kc_track returns "similar" concepts and one is clearly the same idea, call kc_link to merge.
- Do not track small talk, meta questions or clarifications. If the user says "track this" or "don't track this", obey.
- Never mention these tool calls to the user unless asked.`;
