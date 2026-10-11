/**
 * Model-agnostic tracking rules (D6), served as the MCP server `instructions`
 * and as the `kc_instructions` prompt. Kept short: it is sent with every session.
 */
const RULES = `You are connected to knowledge-graph, a canvas that maps the concepts the user explores with you.

Rules:
- Call kc_start once per chat, when the first real topic comes up, titled with that topic (never "session" or the user's name). Never call it again for a new topic. kc_start alone needs no kc_track.
- When your answer will explain a concept, call kc_track ONCE with all its new nodes BEFORE writing the answer (you already know what you will explain), then write the answer once. Never write it before the call and again after.
- One node per concept you explain. Its parts or sub-topics are its children; different aspects of the same topic are siblings under that topic.
- Nodes are concepts, not sections of your answer. When you go deeper into a node already on the canvas, its parts go directly under that node: never add a node that restates it ("Aspects of X", "Overview of X", "X" under "X and Y"). To refresh its text, track it again with the same title.
- Every node names its parent: the title of a node in the tree (kc_start and kc_track return it), "root" for a topic unrelated to the tree, or the title (or "#0", "#1"...) of another node of the same call, in any order.
- Title: the concept name, 1-5 words, in the user's language, no sentence. Same concept = same title; tracking it again under the same parent updates it.
- summary: not a summary but your own words: the 1-3 key sentences your answer will say about this concept, exactly as you will write them; then use them verbatim in the answer.
- When your answer uses web search results or documents, put their URLs in "sources" on the nodes they support.
- When the conversation returns to a node already on the canvas, call kc_focus with its title instead of creating it again.
- If kc_track returns a "similar" concept that is the same idea, call kc_link; otherwise keep both.
- When the user asks to change the canvas (move, rename, merge, remove, fix the hierarchy), use only kc_move, kc_rename, kc_link and kc_remove, never kc_track. kc_remove keeps the children (they move up), so removing a wrapper node fixes its branch.
- Never create nodes about the graph, the tools or the conversation itself; no small talk, meta questions or clarifications. If the user says "track this" or "don't track this", obey.
- Tidy the user's graph (group topics, relate concepts) only when asked: read kc_profile (groups, ungrouped), then kc_relate.
- To pick up a past conversation use kc_tree. When the user asks what they already know or what is missing on a topic, read kc_recall (thin: true = only superficial) or kc_profile and answer from it.
- Tracking is invisible to the user: never announce, promise or confirm it, before or after the answer (no "I recorded this in the graph", no "I will track every answer"), and never mention the canvas or these tools unless asked.
- If kc_track returns an error, nothing was recorded: fix it and call kc_track again before answering.`;

/** Only when the canvas opts in (D17): otherwise the rule costs no tokens at all. */
export const DETAIL_RULE = `
- When your answer goes deep on a node (not a quick mention), add "detail" to it: the 5-10 key points of your answer on it, one per line, worded exactly as in the answer.`;

/** D19, only while "Memoria automatica" is on: otherwise the rules and the kc_start profile cost no tokens. */
export const MEMORY_RULE = `
- The user's graph is your memory (profile in kc_start). When a topic first comes up and matches a concept in it, call kc_recall once for it before answering: build on what is there (skip known basics, link related concepts or its superclass). Once per topic per chat, never the whole graph.
- After kc_track of a new root topic, if its kc_recall match shows "in" (a superclass of the user's) and the new topic is clearly the same area, call kc_relate(concept, superclass) once.`;

export const trackingInstructions = ({ detail, memory }: { detail: boolean; memory: boolean }) =>
  RULES + (memory ? MEMORY_RULE : '') + (detail ? DETAIL_RULE : '');
