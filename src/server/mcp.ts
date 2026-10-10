import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Tracker, TrackerError } from '../core/tracker.ts';
import { Reader } from '../core/reader.ts';
import { TRACKING_INSTRUCTIONS } from './instructions.ts';

/** Per MCP session: which conversation this client is writing to. */
export interface McpSessionState {
  conversationId: string | null;
  client: string | null;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const text = (data: string): CallToolResult => ({ content: [{ type: 'text', text: data }] });
/** Reminder after kc_track: some clients (Claude Desktop) otherwise repeat the answer after the tool call. */
const TRACKED_NOTE = 'Recorded. Now write your answer once; do not repeat it or mention this call.';
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

function guarded(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TrackerError) return fail(err.message);
    throw err;
  }
}

export function createMcpServer(tracker: Tracker, state: McpSessionState): McpServer {
  const server = new McpServer(
    { name: 'knowledge-graph', version: '0.1.0' },
    { instructions: TRACKING_INSTRUCTIONS },
  );

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
        result.content.push({ type: 'text', text: reader.tree(c.id, false, true) });
        return result;
      }),
  );

  server.registerTool(
    'kc_track',
    {
      description: 'Add the concept nodes of the answer you are about to write. One call per answer, before writing it.',
      inputSchema: {
        nodes: z
          .array(
            z.object({
              title: z.string().describe('Concept name, 1-5 words'),
              summary: z.string().describe('1-3 sentences of what you explained'),
              parent: z.string().describe('Title of the node it belongs under (from the tree), "root", or "#n" for an earlier node of this call'),
              excerpt: z.string().optional().describe('Rarely: a formula or code line to keep verbatim'),
              conceptId: z.string().optional().describe('Known concept id to reuse'),
            }),
          )
          .min(1),
      },
    },
    ({ nodes }) =>
      guarded(() => {
        const id = conversationId();
        const result = ok(tracker.track(id, nodes));
        result.content.push({ type: 'text', text: `${reader.tree(id, false, true)}\n${TRACKED_NOTE}` });
        return result;
      }),
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
    'kc_recall',
    {
      description: 'What the user already explored about a topic: concepts, past summaries, dates. Use when a topic first comes up.',
      inputSchema: { query: z.string().describe('Topic or concept name') },
    },
    ({ query }) => guarded(() => ok(reader.recall(query))),
  );

  server.registerTool(
    'kc_tree',
    {
      description: 'Outline of a conversation (default: this one, else the latest) with node ids.',
      inputSchema: {
        conversation: z.string().optional().describe('Conversation id'),
        summaries: z.boolean().optional().describe('Include node summaries'),
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
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: TRACKING_INSTRUCTIONS } }] }),
  );

  return server;
}
