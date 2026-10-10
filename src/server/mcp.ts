import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type TrackNodeInput, type Tracker, TrackerError, type TrackerEvent } from '../core/tracker.ts';
import { Reader } from '../core/reader.ts';
import { DETAIL_RULE, trackingInstructions } from './instructions.ts';
import { VERSION } from '../version.ts';

/** Per MCP session: which conversation this client is writing to. */
export interface McpSessionState {
  conversationId: string | null;
  client: string | null;
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const text = (data: string): CallToolResult => ({ content: [{ type: 'text', text: data }] });
/**
 * Reminder after kc_track: some clients (Claude Desktop) otherwise repeat the answer after the tool call, and
 * models tend to announce the recording ("I recorded this in the graph").
 */
export const TRACKED_NOTE = 'Saved. Now write your answer once, as if no tool had been called: never mention this call, the graph or any recording.';
/** Once per chat, at kc_start: models tended to track after answering and to announce that they would track. */
export const START_NOTE = 'Before each answer that explains a concept, call kc_track first, then answer. Silently: never announce or confirm tracking.';
/** A kc_track error: the batch is atomic, so the model must retry instead of claiming it was recorded. */
export const TRACK_FAILED = 'Nothing was recorded. Fix this and call kc_track again before answering.';
const DETAIL_OFF = 'Detail setting is now off: do not send "detail".';
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

function guarded(fn: () => CallToolResult, onError = ''): CallToolResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TrackerError) return fail(onError ? `${err.message}. ${onError}` : err.message);
    throw err;
  }
}

const detailField = { detail: z.string().optional().describe('Only when going deep on this node: the 5-10 key points of your answer, one per line, word for word') };

/**
 * kc_track input. `detail` is advertised only when the canvas setting is on (D17: no tokens otherwise), but the node
 * object is loose so a `detail` sent by a client with a stale tool list is never dropped by validation.
 */
const trackShape = (withDetail: boolean) => ({
  nodes: z
    .array(
      z.looseObject({
        title: z.string().describe('Concept name, 1-5 words'),
        summary: z.string().describe('The 1-3 key sentences of your answer on it, word for word as you will write them'),
        parent: z.string().describe('Title of the node it belongs under (from the tree, or another node of this call), "root", or "#n" for node n of this call'),
        excerpt: z.string().optional().describe('Rarely: a formula or code line to keep verbatim'),
        conceptId: z.string().optional().describe('Known concept id to reuse'),
        sources: z.array(z.string()).optional().describe('URLs of web results or documents this node relies on'),
        ...(withDetail ? detailField : {}),
      }),
    )
    .min(1),
});

export function createMcpServer(tracker: Tracker, state: McpSessionState): McpServer {
  // D17: the detail field and its rule are exposed only while the canvas setting is on. The server instructions are
  // fixed when the session opens (Claude Desktop keeps one session for its whole life), so a later change re-registers
  // kc_track (tools/list_changed) and is announced once in the next kc_start / kc_track result.
  const instructionsDetail = tracker.settings().detail;
  /** What the model of the current chat was told about detail. */
  let toldDetail = instructionsDetail;
  const detailNote = (on: boolean) => (on ? `Detail setting is now on:${DETAIL_RULE.slice(2)}` : DETAIL_OFF);
  const server = new McpServer({ name: 'knowledge-graph', version: VERSION }, { instructions: trackingInstructions(instructionsDetail) });

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
        // A new chat knows only the server instructions: tell it when the detail setting changed since.
        const detail = tracker.settings().detail;
        toldDetail = detail;
        const notes = detail === instructionsDetail ? START_NOTE : `${START_NOTE}\n${detailNote(detail)}`;
        const result = ok({ conversation: c.id });
        result.content.push({ type: 'text', text: `${reader.tree(c.id, false, true)}\n${notes}` });
        return result;
      }),
  );

  const kcTrack = server.registerTool(
    'kc_track',
    {
      description: 'Add the concept nodes of the answer you are about to write. One call per answer, before writing it.',
      inputSchema: trackShape(instructionsDetail),
    },
    ({ nodes }) =>
      guarded(() => {
        const detail = tracker.settings().detail;
        const input = (nodes as TrackNodeInput[]).map((n) => (detail ? n : { ...n, detail: undefined }));
        const id = conversationId();
        const result = ok(tracker.track(id, input));
        const notes = detail === toldDetail ? TRACKED_NOTE : `${detailNote(detail)}\n${TRACKED_NOTE}`;
        toldDetail = detail;
        result.content.push({ type: 'text', text: `${reader.tree(id, false, true)}\n${notes}` });
        return result;
      }, TRACK_FAILED),
  );

  // The canvas toggled "Dettaglio approfondito": re-advertise kc_track at once (sends tools/list_changed).
  const onChange = (e: TrackerEvent) => {
    if (e.type === 'settings.changed') kcTrack.update({ paramsSchema: trackShape(e.settings.detail) });
  };
  tracker.events.on('change', onChange);
  server.server.onclose = () => tracker.events.off('change', onChange);

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
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: trackingInstructions(tracker.settings().detail) } }] }),
  );

  return server;
}
