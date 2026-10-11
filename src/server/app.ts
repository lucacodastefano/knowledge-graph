import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { type Tracker, TrackerError, type TrackerEvent, type VisitEdit } from '../core/tracker.ts';
import { Reader } from '../core/reader.ts';
import type { Settings } from '../core/types.ts';
import { createMcpServer, type McpSessionState } from './mcp.ts';
import { VERSION } from '../version.ts';

export interface AppOptions {
  tracker: Tracker;
  /** Built canvas (web/dist); served at / when present. */
  webRoot?: string;
  logger?: boolean;
  /** Graceful stop, exposed as POST /api/shutdown (local origins only, like every route). */
  onShutdown?: () => void;
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

export async function buildApp({ tracker, webRoot, logger = false, onShutdown }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(websocket);

  // Domain errors (unknown id, invalid edit) are the caller's fault.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof TrackerError) return reply.code(/not found/.test(err.message) ? 404 : 409).send({ error: err.message });
    return reply.send(err);
  });

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
  // The stdio bridge compares the version with its own and replaces an older daemon (stopping it via shutdown or pid).
  app.get('/api/health', async () => ({ ok: true, version: VERSION, pid: process.pid }));
  if (onShutdown) {
    app.post('/api/shutdown', async (_req, reply) => {
      reply.code(202).send({ ok: true });
      setImmediate(onShutdown);
      return reply;
    });
  }
  app.get('/api/conversations', async () => repo.listConversations());
  app.get<{ Params: { id: string } }>('/api/conversations/:id/tree', async (req, reply) => {
    const tree = repo.getTree(req.params.id);
    return tree ?? reply.code(404).send({ error: 'Not found' });
  });
  // Where the user put nodes and relation bends on the canvas (kept across refreshes and layout changes).
  app.get('/api/layout', async () => repo.layoutEntries());
  app.post<{ Body: { items: { kind: 'visit' | 'relation'; id: string; x?: number; y?: number }[] } }>(
    '/api/layout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              maxItems: 5000,
              items: {
                type: 'object',
                required: ['kind', 'id'],
                properties: { kind: { enum: ['visit', 'relation'] }, id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      repo.setLayout(req.body.items);
      return reply.code(204).send();
    },
  );
  app.get('/api/graph', async () => repo.getPersonalGraph());
  app.get<{ Params: { id: string } }>('/api/concepts/:id', async (req, reply) => {
    const page = new Reader(repo).conceptPage(req.params.id);
    return page ?? reply.code(404).send({ error: 'Not found' });
  });
  app.get('/api/settings', async () => tracker.settings());
  app.patch<{ Body: Partial<Settings> }>(
    '/api/settings',
    { schema: { body: { type: 'object', properties: { memory: { type: 'boolean' } }, additionalProperties: false } } },
    async (req) => tracker.updateSettings(req.body),
  );

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => new Reader(repo).search(req.query.q ?? ''));

  // --- Manual corrections (D8): every change is broadcast on /ws like the model's ones ---
  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/concepts/:id',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
    async (req) => tracker.renameConcept(req.params.id, req.body.name),
  );
  app.post<{ Params: { id: string }; Body: { into: string } }>(
    '/api/concepts/:id/merge',
    { schema: { body: { type: 'object', required: ['into'], properties: { into: { type: 'string' } } } } },
    async (req) => tracker.mergeConcepts(req.params.id, req.body.into),
  );
  app.delete<{ Params: { id: string } }>('/api/concepts/:id', async (req, reply) => {
    tracker.deleteConcept(req.params.id);
    return reply.code(204).send();
  });
  app.patch<{ Params: { id: string }; Body: VisitEdit }>(
    '/api/visits/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            detail: { type: ['string', 'null'] },
            parentVisitId: { type: ['string', 'null'] },
            conceptId: { type: 'string' },
          },
        },
      },
    },
    async (req) => tracker.editVisit(req.params.id, req.body),
  );
  const relationBody = {
    type: 'object',
    required: ['from', 'to'],
    properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: ['string', 'null'] } },
  };
  app.post<{ Body: { from: string; to: string; label?: string | null } }>('/api/relations', { schema: { body: relationBody } }, async (req, reply) => {
    tracker.setRelation(req.body.from, req.body.to, true, req.body.label);
    return reply.code(204).send();
  });
  // Superclasses (D18): "Raggruppa in…", the suggestions and their accept / ignore.
  app.get('/api/suggestions', async () => new Reader(repo).suggestions());
  app.post<{ Body: { key: string } }>(
    '/api/suggestions/ignore',
    { schema: { body: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } } },
    async (req, reply) => {
      tracker.ignoreSuggestion(req.body.key);
      return reply.code(204).send();
    },
  );
  app.post<{ Body: { name: string; conceptIds: string[] } }>(
    '/api/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'conceptIds'],
          properties: { name: { type: 'string' }, conceptIds: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    async (req) => tracker.group(req.body.name, req.body.conceptIds),
  );
  app.patch<{ Params: { id: string }; Body: { superclassId: string | null } }>(
    '/api/concepts/:id/superclass',
    { schema: { body: { type: 'object', required: ['superclassId'], properties: { superclassId: { type: ['string', 'null'] } } } } },
    async (req, reply) => {
      tracker.setSuperclass(req.params.id, req.body.superclassId);
      return reply.code(204).send();
    },
  );
  app.post<{ Body: { from: string; to: string } }>('/api/relations/remove', { schema: { body: relationBody } }, async (req, reply) => {
    tracker.setRelation(req.body.from, req.body.to, false);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string }; Querystring: { children?: string } }>('/api/visits/:id', async (req, reply) => {
    tracker.deleteVisit(req.params.id, req.query.children === 'detach');
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    tracker.deleteConversation(req.params.id);
    return reply.code(204).send();
  });
  // Undo of a node deleted from the canvas.
  app.post<{ Body: Parameters<Tracker['restoreVisit']>[0] }>('/api/visits/restore', async (req) => tracker.restoreVisit(req.body));
  app.delete<{ Params: { id: string; sourceId: string } }>('/api/visits/:id/sources/:sourceId', async (req, reply) => {
    tracker.removeVisitSource(req.params.id, req.params.sourceId);
    return reply.code(204).send();
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
