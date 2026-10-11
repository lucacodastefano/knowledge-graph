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
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const text = (data: string): CallToolResult => ({ content: [{ type: 'text', text: data }] });
export const TRACKED_NOTE = 'Saved in the map. Write your answer now, once.';
export const START_NOTE = 'Before each answer that explains a concept, call kc_track with its nodes, then write the answer.';
/** A kc_track error: the batch is atomic, so the model must retry instead of claiming it was recorded. */
export const TRACK_FAILED = 'Nothing was recorded. Fix this and call kc_track again before answering.';
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
        detail: z.string().optional().describe('Full text of your answer on this concept, markdown: explanations, lists, tables, numbers, examples, caveats'),
        parent: z.string().describe('Title of the node it belongs under (from the tree, or another node of this call), "root", or "#n" for node n of this call'),
        excerpt: z.string().optional().describe('Rarely: a formula or code line to keep as is'),
        conceptId: z.string().optional().describe('Known concept id to reuse'),
        sources: z.array(z.string()).optional().describe('URLs of web results or documents this node relies on'),
      }),
    )
    .min(1),
});

export function createMcpServer(tracker: Tracker, state: McpSessionState): McpServer {
  // D19: like the server instructions, the memory profile follows the setting as it was when the session opened.
  const instructionsMemory = tracker.settings().memory;
  const server = new McpServer({ name: 'knowledge-graph', version: VERSION }, { instructions: trackingInstructions({ memory: instructionsMemory }) });

  const reader = new Reader(tracker.repo);

  const conversationId = () => {
    if (!state.conversationId) state.conversationId = tracker.startConversation(undefined, state.client).id;
    return state.conversationId;
  };

  server.registerTool(
    'kc_start',
    {
      description: 'Start the canvas conversation at the first real topic of every chat (once per chat; a new topic is kc_track with parent "root"), or resume one by id.',
      inputSchema: { title: z.string().optional(), resume: z.string().optional() },
    },
    ({ title, resume }) =>
      guarded(() => {
        const c = resume ? tracker.requireConversation(resume) : tracker.startConversation(title, state.client);
        state.conversationId = c.id;
        const result = ok({ conversation: c.id });
        const profile = instructionsMemory && !resume ? reader.memoryProfile() : '';
        result.content.push({ type: 'text', text: `${reader.tree(c.id, false, true)}\n${profile ? `${profile}\n` : ''}${START_NOTE}` });
        return result;
      }),
  );

  server.registerTool(
    'kc_track',
    {
      description: 'Add the concept nodes of the answer you are about to write. One call per answer, before writing it.',
      inputSchema: trackShape(),
    },
    ({ nodes }) =>
      guarded(() => {
        const id = conversationId();
        const result = ok(tracker.track(id, nodes as TrackNodeInput[]));
        result.content.push({ type: 'text', text: `${reader.tree(id, false, true)}\n${TRACKED_NOTE}` });
        return result;
      }, TRACK_FAILED),
  );

  server.registerTool(
    'kc_focus',
    {
      description: 'Move back to a node already on the canvas; it becomes the current node.',
      inputSchema: { node: z.string().describe('Title or id') },
    },
    ({ node }) =>
      guarded(() => {
        const id = conversationId();
        const visit = tracker.resolveNode(id, node);
        tracker.focus(id, visit.id);
        return ok({ current: visit.id });
      }),
  );

  server.registerTool(
    'kc_link',
    {
      description: 'Merge a node into an existing concept: same idea under two names (e.g. kc_track reported it as similar). To re-attach a node elsewhere use kc_move.',
      inputSchema: { node: z.string(), conceptId: z.string() },
    },
    ({ node, conceptId }) =>
      guarded(() => {
        const v = tracker.link(conversationId(), node, conceptId);
        return ok({ node: v.id, conceptId: v.conceptId });
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
      description: 'What the user already explored about a topic: concepts, past summaries, dates; thin = only superficial. Use when a topic first comes up.',
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
      description: 'Outline of a conversation (default: this one, else the latest) with node ids.',
      inputSchema: {
        conversation: z.string().optional().describe('Conversation id'),
        summaries: z.boolean().optional().describe('Include node texts'),
      },
    },
    ({ conversation, summaries }) =>
      guarded(() => text(reader.tree(conversation ?? state.conversationId, summaries ?? false))),
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
