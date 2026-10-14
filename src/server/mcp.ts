import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type TrackNodeInput, type Tracker, TrackerError } from '../core/tracker.ts';
import { Reader } from '../core/reader.ts';
import { trackingInstructions } from './instructions.ts';
import { VERSION } from '../version.ts';
import { meterTools } from './metering.ts';

/** Per MCP session: which conversation this client is writing to. */
export interface McpSessionState {
  conversationId: string | null;
  client: string | null;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const text = (data: string): CallToolResult => ({ content: [{ type: 'text', text: data }] });
export const TRACKED_NOTE = 'Saved in the graph. Write your answer now, once.';
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
  const server = new McpServer({ name: 'knowledge-graph', version: VERSION }, { instructions: trackingInstructions() });

  meterTools(server, tracker, state);
  const reader = new Reader(tracker.repo);

  const conversationId = () => {
    if (!state.conversationId) state.conversationId = tracker.startConversation(undefined, state.client).id;
    return state.conversationId;
  };
  /** Tools that only read need a graph of this chat: they never fall back to another one (D22). */
  const startedConversation = () => {
    if (!state.conversationId) throw new TrackerError('No graph started in this chat: call kc_start first');
    return state.conversationId;
  };

  server.registerTool(
    'kc_start',
    {
      description:
        'Start this chat\'s graph at the first real topic (once per chat; a new topic is kc_track with parent "root"). A title always makes a new empty graph. Only to continue an earlier graph the user asked for, pass resume: its id or title.',
      inputSchema: { title: z.string().optional(), resume: z.string().optional() },
    },
    ({ title, resume }) =>
      guarded(() => {
        const c = resume ? tracker.findConversation(resume) : tracker.startConversation(title, state.client);
        state.conversationId = c.id;
        const result = ok({ conversation: c.id });
        result.content.push({ type: 'text', text: `${reader.tree(c.id, false, true)}\n${START_NOTE}` });
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
        const similar = results.flatMap((r, i) => r.similar.map((m) => `"${nodes[i].title.trim()}" ~ "${m.name}" (conceptId ${m.id})`));
        const text = [
          `Graph: ${tracker.requireConversation(id).title}`,
          reader.tree(id, false, true, new Set(results.map((r) => r.id))),
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
      description: 'Make a node of this graph current again. To go deeper, kc_track its parts instead.',
      inputSchema: { node: z.string().describe('Title or id') },
    },
    ({ node }) =>
      guarded(() => {
        const id = conversationId();
        const visit = tracker.resolveNode(id, node);
        tracker.focus(id, visit.id);
        return text(`Current: ${visit.title}`);
      }, 'If it is in another graph, kc_track it here in your own words instead.'),
  );

  server.registerTool(
    'kc_link',
    {
      description: 'Merge a node into another concept of this graph: same idea under two names (e.g. kc_track reported it as similar). To re-attach a node elsewhere use kc_move.',
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
      description: 'Nodes of this graph that already cover a topic: summaries, parent, sources (thin:true = superficial). Not for other graphs.',
      inputSchema: { query: z.string().describe('Topic or concept name') },
    },
    ({ query }) => guarded(() => ok(reader.recall(startedConversation(), query))),
  );

  server.registerTool(
    'kc_search_graphs',
    {
      description: "Search the user's OTHER graphs; titles and summaries only, grouped by graph. Use only when the user explicitly asks to look in their other graphs; then kc_read(node, graph) for the text.",
      inputSchema: { query: z.string().describe('Topic or words') },
    },
    ({ query }) => guarded(() => ok(reader.searchGraphs(state.conversationId, query))),
  );

  server.registerTool(
    'kc_relate',
    {
      description:
        'Group a concept under a superclass (one per concept; created if new) or relate it to another concept, with an optional label. Concepts must already be in this graph.',
      inputSchema: {
        concept: z.string().describe('Concept name'),
        superclass: z.string().optional().describe('Kind-of / part-of group, e.g. "IT architecture"'),
        related_to: z.string().optional().describe('Another concept of this graph'),
        label: z.string().optional().describe('Short verb for related_to, e.g. "governs"'),
      },
    },
    ({ concept, superclass, related_to, label }) =>
      guarded(() => ok({ done: tracker.relateByName(startedConversation(), { concept, superclass, relatedTo: related_to, label }) })),
  );

  server.registerTool(
    'kc_tree',
    {
      description: 'Outline of this graph, with its relations. A big graph shows 2 levels, collapsed branches as (+N): open one with root.',
      inputSchema: {
        summaries: z.boolean().optional().describe('Include node texts'),
        root: z.string().optional().describe('Title of a node: outline only its branch'),
        depth: z.number().int().min(1).optional().describe('Levels to show (default 2 on a big map)'),
        relations: z.boolean().optional().describe('Also list the dashed relations'),
      },
    },
    ({ summaries, root, depth, relations }) =>
      guarded(() => text(reader.tree(startedConversation(), summaries ?? false, false, undefined, { root, depth, relations, orient: true }))),
  );

  server.registerTool(
    'kc_read',
    {
      description: "Full text of one node of this graph and its children's titles. `graph` (id or title) reads a node of another graph: only after kc_search_graphs.",
      inputSchema: { node: z.string().describe('Title'), graph: z.string().optional().describe('Another graph, only after kc_search_graphs') },
    },
    ({ node, graph }) =>
      guarded(() => text(reader.read(graph ? tracker.findConversation(graph).id : startedConversation(), node))),
  );

  server.registerPrompt(
    'kc_instructions',
    { description: 'How to keep the knowledge-graph canvas up to date during a chat.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: trackingInstructions() } }] }),
  );

  return server;
}
