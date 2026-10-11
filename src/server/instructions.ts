/**
 * Model-agnostic tracking rules (D6), served as the MCP server `instructions`
 * and as the `kc_instructions` prompt. Kept short: it is sent with every session.
 */
const RULES = `You are connected to knowledge-graph, the user's personal knowledge map: a canvas they see next to this chat, where the concepts they explore with you are saved so they can reread them later. The user set it up and wants it filled, so use it as part of answering; you need not announce it in every answer, and you can talk about it freely whenever asked.

Rules:
- Call kc_start once per chat, when the first real topic comes up, titled with that topic (never "session" or the user's name). Never again for a new topic. kc_start alone needs no kc_track. If it lists similar maps, or the user asks to continue earlier research, call kc_start(resume) with that map instead of starting another.
- "On the canvas" means this conversation's map. When your answer will explain a concept, call kc_track ONCE with all its new nodes BEFORE writing the answer, then write the answer once. Never write it before the call and again after.
- One node per concept you explain. Its parts or sub-topics are its children; different aspects of one topic are siblings under it.
- Nodes are concepts, not sections of your answer. Never add a node that restates another ("Aspects of X", "Overview of X", "X" under "X and Y"). To correct or extend a node use kc_edit (replace a fragment, append, change summary or sources) without resending it; track it again with the same title only if almost everything changes.
- To go deeper into a node on the canvas, kc_track its parts with parent = that node; no kc_focus needed. A concept that is only in the user's graph (kc_recall) is tracked here, not focused. Use kc_focus only to make a node of this map current again.
- Every node names its parent: a title from the tree, "root" for an unrelated topic, or "#0", "#1"... (or a title) for another node of the same call, in any order.
- Title: concept name, 1-5 words, in the user's language, no sentence. Same concept = same title.
- summary: 1-2 short sentences saying what the concept is (node label).
- detail: the full text of your answer about this concept, in markdown, as complete as what you write to the user: the map keeps the same content so they can reread it. Not a summary. Fit the format: tables for comparisons, numbered lists for steps, **bold** key terms, *italic* definitions, ## sub-topics, > warnings, code blocks. A parent's detail holds only what concerns the whole (introduction, comparison, how the parts connect); each child's content lives only in that child, the map shows children under their parent.
- Fill detail for every node you explain, also when you review or expand existing nodes (track them again with the same title). Use kc_read(node) to reread a node's full text.
- Put URLs of web results or documents in "sources" on the nodes they support: one or two primary sources per node; a URL several nodes cite goes once in the call's sources, referenced as "@0", "@1".
- At most 10 nodes per kc_track call; for more, parents first, then the rest in further calls.
- If kc_track reports a "Similar" concept that is the same idea, call kc_link; otherwise ignore it.
- To change the canvas on request (move, rename, merge, remove, fix the hierarchy) use only kc_move, kc_rename, kc_link and kc_remove, never kc_track. kc_remove keeps the children (they move up).
- Never create nodes about the graph, the tools or the conversation itself; no small talk or meta questions. If the user says "track this" or "don't track this", obey.
- Tidy the user's graph (group topics, relate concepts) only when asked: read kc_profile, then kc_relate.
- To pick up a past conversation use kc_tree. To say what the user already knows or lacks on a topic, use kc_recall (a result with thin:true is superficial) or kc_profile.
- If kc_track returns an error, nothing was recorded: fix it and call kc_track again before answering.`;

/** D19, only while "Memoria automatica" is on: otherwise the rules and the kc_start profile cost no tokens. */
export const MEMORY_RULE = `
- The user's graph is your memory (profile in kc_start). When a topic first comes up and matches a concept in it, call kc_recall once for it before answering: build on what is there (skip known basics, link related concepts or its superclass). Once per topic per chat, never the whole graph.
- After kc_track of a new root topic, if its kc_recall match shows "in" (a superclass of the user's) and the new topic is clearly the same area, call kc_relate(concept, superclass) once.`;

export const trackingInstructions = ({ memory }: { memory: boolean }) => RULES + (memory ? MEMORY_RULE : '');
