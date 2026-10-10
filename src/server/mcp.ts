import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Tracker, TrackerError } from '../core/tracker.ts';
import { TRACKING_INSTRUCTIONS } from './instructions.ts';

/** Per MCP session: which conversation this client is writing to. */
export interface McpSessionState {
  conversationId: string | null;
  client: string | null;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
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

  const conversationId = () => {
    if (!state.conversationId) state.conversationId = tracker.startConversation(undefined, state.client).id;
    return state.conversationId;
  };

  server.registerTool(
    'kc_start',
    {
      description: 'Start a new conversation on the canvas, or resume one by id.',
      inputSchema: { title: z.string().optional(), resume: z.string().optional() },
    },
    ({ title, resume }) =>
      guarded(() => {
        const c = resume ? tracker.requireConversation(resume) : tracker.startConversation(title, state.client);
        state.conversationId = c.id;
        return ok({ conversation: c.id, current: c.currentVisitId });
      }),
  );

  server.registerTool(
    'kc_track',
    {
      description: 'Add one or more concept nodes for your last answer. One call per answer.',
      inputSchema: {
        nodes: z
          .array(
            z.object({
              title: z.string().describe('Concept name, 1-5 words'),
              summary: z.string().describe('1-3 sentences of what you explained'),
              parent: z.string().optional().describe('"current" (default), "root", a node id, or "#n"'),
              excerpt: z.string().optional(),
              conceptId: z.string().optional().describe('Known concept id to reuse'),
            }),
          )
          .min(1),
      },
    },
    ({ nodes }) => guarded(() => ok(tracker.track(conversationId(), nodes))),
  );

  server.registerTool(
    'kc_focus',
    {
      description: 'Move back to a node already on the canvas; it becomes the current node.',
      inputSchema: { node: z.string() },
    },
    ({ node }) =>
      guarded(() => {
        tracker.focus(conversationId(), node);
        return ok({ current: node });
      }),
  );

  server.registerTool(
    'kc_link',
    {
      description: 'Merge a node into an existing concept (when kc_track reported it as similar).',
      inputSchema: { node: z.string(), conceptId: z.string() },
    },
    ({ node, conceptId }) =>
      guarded(() => {
        const v = tracker.link(conversationId(), node, conceptId);
        return ok({ node: v.id, conceptId: v.conceptId });
      }),
  );

  server.registerPrompt(
    'kc_instructions',
    { description: 'How to keep the knowledge-graph canvas up to date during a conversation.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: TRACKING_INSTRUCTIONS } }] }),
  );

  return server;
}
