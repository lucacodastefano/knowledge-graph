import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Tracker, TrackerEvent } from '../core/tracker.ts';
import { createMcpServer, type McpSessionState } from './mcp.ts';

export interface AppOptions {
  tracker: Tracker;
  /** Built canvas (web/dist); served at / when present. */
  webRoot?: string;
  logger?: boolean;
}

/** Only local pages may talk to the daemon (DNS-rebinding protection). Clients without Origin (CLIs) are allowed. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export async function buildApp({ tracker, webRoot, logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    if (!isAllowedOrigin(req.headers.origin)) return reply.code(403).send({ error: 'Origin not allowed' });
  });

  // --- MCP (Streamable HTTP, one transport + server per MCP session) ---
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleMcp = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== 'POST' || sessionId || !isInitializeRequest(req.body)) {
        return reply.code(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session' }, id: null });
      }
      const state: McpSessionState = { conversationId: null, client: null };
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, t);
        },
      });
      t.onclose = () => {
        if (t.sessionId) transports.delete(t.sessionId);
      };
      const body = req.body as { params?: { clientInfo?: { name?: string } } };
      state.client = body.params?.clientInfo?.name ?? null;
      await createMcpServer(tracker, state).connect(t);
      transport = t;
    }

    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  app.post('/mcp', handleMcp);
  app.get('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

  // --- REST for the canvas ---
  const repo = tracker.repo;
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/conversations', async () => repo.listConversations());
  app.get<{ Params: { id: string } }>('/api/conversations/:id/tree', async (req, reply) => {
    const tree = repo.getTree(req.params.id);
    return tree ?? reply.code(404).send({ error: 'Not found' });
  });
  app.get<{ Params: { id: string } }>('/api/concepts/:id', async (req, reply) => {
    const detail = repo.getConceptDetail(req.params.id);
    return detail ?? reply.code(404).send({ error: 'Not found' });
  });

  // --- Live updates ---
  app.get('/ws', { websocket: true }, (socket) => {
    const forward = (e: TrackerEvent) => socket.send(JSON.stringify(e));
    tracker.events.on('change', forward);
    socket.on('close', () => tracker.events.off('change', forward));
  });

  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
  }

  app.addHook('onClose', async () => {
    await Promise.all([...transports.values()].map((t) => t.close()));
  });

  return app;
}
