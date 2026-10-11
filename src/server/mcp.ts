import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type TrackNodeInput, type Tracker, TrackerError } from '../core/tracker.ts';
import { Reader } from '../core/reader.ts';
import { trackingInstructions } from './instructions.ts';
import { VERSION } from '../version.ts';

/** Per MCP session: which conversation this client is writing to. */
export interface McpSessionState {
  conversationId: string | null;
  client: string | null;
  /** Title given to kc_start while similar maps were on offer: the map is created on the first kc_track unless one is resumed. */
  pendingTitle?: string | null;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const text = (data: string): CallToolResult => ({ content: [{ type: 'text', text: data }] });
export const TRACKED_NOTE = 'Saved in the map. Write your answer now, once.';
export const START_NOTE = 'Before each answer that explains a concept, call kc_track with its nodes, then write the answer.';
/** A kc_track error: the batch is atomic, so the model must retry instead of claiming it was recorded. */
export const TRACK_FAILED = 'Nothing was recorded. Fix this and call kc_track again before answering.';
/** Nodes per kc_track call: bigger calls risk a client timeout, and nothing is saved if one fails. */
export const MAX_TRACK_NODES = 10;
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

function guarded(fn: () => CallToolResult, onError = ''): CallToolResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TrackerError) return fail(onError ? `${err.message}. ${onError}` : err.message);
    throw err;
  }
}

/** kc_track input; the node object is loose so a field sent by a client with a stale tool list is never dropped. */
const trackShape = () => ({
  nodes: z
    .array(
      z.looseObject({
        title: z.string().describe('Concept name, 1-5 words'),
        summary: z.string().describe('1-2 short sentences: what the concept is (node label)'),
        detail: z.string().optional().describe('Full text of your answer on this concept, in markdown (tables, lists, **bold**, code); only what concerns this node, not its children'),
        parent: z.string().describe('Title of the node it belongs under (from the tree, or another node of this call), "root", or "#n" for node n of this call'),
        excerpt: z.string().optional().describe('Rarely: a formula or code line to keep as is'),
        conceptId: z.string().optional().describe('Known concept id to reuse'),
        sources: z.array(z.string()).optional().describe('URLs of web results or documents this node relies on, or "@n" for sources[n]'),
      }),
    )
    .min(1),
  sources: z.array(z.string()).optional().describe('URLs several nodes cite: write each once here and give the nodes "@0", "@1"... in their sources'),
});

/** "@n" in a node's sources points to sources[n] of the call: each URL is written once. */
function expandSources(nodes: TrackNodeInput[], shared: string[] | undefined): TrackNodeInput[] {
  if (!nodes.some((n) => n.sources?.some((u) => /^@\d+$/.test(u)))) return nodes;
  return nodes.map((n) => ({
    ...n,
    sources: n.sources?.flatMap((u) => {
      if (!/^@\d+$/.test(u)) return [u];
      const url = shared?.[Number(u.slice(1))];
      if (!url) throw new TrackerError(`Source ${u} is not in sources`);
      return [url];
    }),
  }));
}

export function createMcpServer(tracker: Tracker, state: McpSessionState): McpServer {
  // D19: like the server instructions, the memory profile follows the setting as it was when the session opened.
  const instructionsMemory = tracker.settings().memory;
  const server = new McpServer({ name: 'knowledge-graph', version: VERSION }, { instructions: trackingInstructions({ memory: instructionsMemory }) });

  const reader = new Reader(tracker.repo);

  const conversationId = () => {
    if (!state.conversationId) state.conversationId = tracker.startConversation(state.pendingTitle ?? undefined, state.client).id;
    return state.conversationId;
  };

  server.registerTool(
    'kc_start',
    {
      description:
        'Start the canvas conversation at the first real topic of every chat (once per chat; a new topic is kc_track with parent "root"). To continue an earlier map ("continue the research on X"), pass resume: its id or title.',
      inputSchema: { title: z.string().optional(), resume: z.string().optional() },
    },
    ({ title, resume }) =>
      guarded(() => {
        let c;
        let note = START_NOTE;
        let similar: ReturnType<Reader['similarMaps']> = [];
        state.pendingTitle = null;
        const same = resume ? undefined : tracker.sameTitle(title);
        if (resume) {
          c = tracker.findConversation(resume);
        } else if (same) {
          c = same;
          note = `Resumed the existing map "${c.title}" instead of creating another. ${START_NOTE}`;
        } else {
          similar = title ? reader.similarMaps(title) : [];
          // With similar maps on offer the new one is held back until the model decides, so no empty duplicate is left.
          if (similar.length) state.pendingTitle = title;
          else c = tracker.startConversation(title, state.client);
        }
        state.conversationId = c?.id ?? null;
        const lines = similar.length
          ? [
              `Similar maps: ${similar.map((m) => `"${m.title}" [${m.id}] ${m.last}, ${m.nodes} nodes`).join('; ')}`,
              'To continue one, call kc_start(resume: its id or title) instead of starting another. Otherwise kc_track starts a new map.',
            ]
          : [];
        const result = ok({ conversation: state.conversationId });
        const profile = instructionsMemory && c && !resume && !same ? reader.memoryProfile() : '';
        const tree = c ? `${reader.tree(c.id, false, true)}\n` : '';
        result.content.push({ type: 'text', text: `${tree}${lines.length ? `${lines.join('\n')}\n` : ''}${profile ? `${profile}\n` : ''}${note}` });
        return result;
      }),
  );

  server.registerTool(
    'kc_track',
    {
      description: 'Add the concept nodes of the answer you are about to write. One call per answer, before writing it.',
      inputSchema: trackShape(),
    },
    ({ nodes, sources }) =>
      guarded(() => {
        if (nodes.length > MAX_TRACK_NODES) {
          throw new TrackerError(`${nodes.length} nodes in one call, max ${MAX_TRACK_NODES}. Split it: parents first, then the rest with parent = a title already saved`);
        }
        const id = conversationId();
        const results = tracker.track(id, expandSources(nodes as TrackNodeInput[], sources));
        // Lean result: the touched branch, plus only what needs a decision (no ids, no empty or false fields).
        const known = results.flatMap((r, i) => (r.knownConcept && !r.updated ? [nodes[i].title.trim()] : []));
        const similar = results.flatMap((r, i) => r.similar.map((m) => `"${nodes[i].title.trim()}" ~ "${m.name}" (conceptId ${m.id})`));
        const text = [
          reader.tree(id, false, true, new Set(results.map((r) => r.id))),
          ...(known.length ? [`Known: ${known.join(', ')}`] : []),
          ...(similar.length ? [`Similar: ${similar.join('; ')}`] : []),
          TRACKED_NOTE,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      }, TRACK_FAILED),
  );

  server.registerTool(
    'kc_edit',
    {
      description:
        'Change part of a node without resending it: replace a fragment of its detail, append text (at the end or under a heading), set the summary, add or remove sources. For corrections; rewrite the node with kc_track only if almost everything changes.',
      inputSchema: {
        node: z.string().describe('Title or id'),
        find: z.string().optional().describe('Exact fragment of the detail to replace (must occur once)'),
        replace: z.string().optional().describe('New text for find; "" deletes it'),
        append: z.string().optional().describe('Markdown added at the end of the detail'),
        under: z.string().optional().describe('With append: add at the end of the section with this heading'),
        summary: z.string().optional().describe('New summary (node label)'),
        add_sources: z.array(z.string()).optional(),
        remove_sources: z.array(z.string()).optional(),
      },
    },
    ({ node, add_sources, remove_sources, ...edit }) =>
      guarded(() => {
        const id = conversationId();
        const { visit, changes } = tracker.editNode(id, node, { ...edit, addSources: add_sources, removeSources: remove_sources });
        return text(`Edited "${visit.title}": ${changes.join(', ')}.`);
      }),
  );

  server.registerTool(
    'kc_focus',
    {
      description: 'Make a node of this conversation\'s map current again. To go deeper, kc_track its parts instead.',
      inputSchema: { node: z.string().describe('Title or id') },
    },
    ({ node }) =>
      guarded(() => {
        const id = conversationId();
        const visit = tracker.resolveNode(id, node);
        tracker.focus(id, visit.id);
        return text(`Current: ${visit.title}`);
      }, 'If it is only in the user\'s graph, kc_track it here instead.'),
  );

  server.registerTool(
    'kc_link',
    {
      description: 'Merge a node into an existing concept: same idea under two names (e.g. kc_track reported it as similar). To re-attach a node elsewhere use kc_move.',
      inputSchema: { node: z.string().describe('Title of the node'), conceptId: z.string().describe('conceptId from the Similar line') },
    },
    ({ node, conceptId }) =>
      guarded(() => {
        const id = conversationId();
        const v = tracker.link(id, tracker.resolveNode(id, node).id, conceptId);
        return text(`Linked: ${v.title}`);
      }),
  );

  server.registerTool(
    'kc_move',
    {
      description: 'Move a node (with its children) under another node, or to "root". Does not merge concepts.',
      inputSchema: {
        node: z.string().describe('Title or id of the node to move'),
        parent: z.string().describe('Title or id of the new parent, or "root"'),
      },
    },
    ({ node, parent }) =>
      guarded(() => {
        const id = conversationId();
        tracker.move(id, node, parent);
        return text(reader.tree(id, false, true));
      }),
  );

  server.registerTool(
    'kc_rename',
    {
      description: 'Rename a node. A title already used by another concept links the two (same concept).',
      inputSchema: { node: z.string().describe('Title or id'), title: z.string() },
    },
    ({ node, title }) =>
      guarded(() => {
        const id = conversationId();
        tracker.rename(id, node, title);
        return text(reader.tree(id, false, true));
      }),
  );

  server.registerTool(
    'kc_remove',
    {
      description: 'Remove a node; its children move up to its parent.',
      inputSchema: { node: z.string().describe('Title or id') },
    },
    ({ node }) =>
      guarded(() => {
        const id = conversationId();
        tracker.remove(id, node);
        return text(reader.tree(id, false, true));
      }),
  );

  server.registerTool(
    'kc_recall',
    {
      description: 'What the user already explored about a topic: concepts, past summaries, dates (thin:true in a result = superficial). Use when a topic first comes up.',
      inputSchema: { query: z.string().describe('Topic or concept name') },
    },
    ({ query }) => guarded(() => ok(reader.recall(query))),
  );

  server.registerTool(
    'kc_relate',
    {
      description:
        'Group a concept under a superclass (one per concept; created if new) or relate it to another concept, with an optional label. Concepts must already be on the canvas.',
      inputSchema: {
        concept: z.string().describe('Concept name'),
        superclass: z.string().optional().describe('Kind-of / part-of group, e.g. "IT architecture"'),
        related_to: z.string().optional().describe('Another concept'),
        label: z.string().optional().describe('Short verb for related_to, e.g. "governs"'),
      },
    },
    ({ concept, superclass, related_to, label }) =>
      guarded(() => ok({ done: tracker.relateByName({ concept, superclass, relatedTo: related_to, label }) })),
  );

  server.registerTool(
    'kc_tree',
    {
      description: 'Outline of a conversation (default: this one, else the latest), with its relations.',
      inputSchema: {
        conversation: z.string().optional().describe('Conversation id'),
        summaries: z.boolean().optional().describe('Include node texts'),
      },
    },
    ({ conversation, summaries }) =>
      guarded(() => text(reader.tree(conversation ?? state.conversationId, summaries ?? false))),
  );

  server.registerTool(
    'kc_read',
    {
      description: 'Full text of one node (title in this conversation, or a concept of the user\'s graph) and its children\'s titles.',
      inputSchema: { node: z.string().describe('Title') },
    },
    ({ node }) => guarded(() => text(reader.read(state.conversationId, node))),
  );

  server.registerTool(
    'kc_profile',
    { description: "Overview of the user's knowledge: top and recent concepts, last conversations." },
    () => guarded(() => ok(reader.profile())),
  );

  server.registerPrompt(
    'kc_instructions',
    { description: 'How to keep the knowledge-graph canvas up to date during a conversation.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: trackingInstructions(tracker.settings()) } }] }),
  );

  return server;
}
