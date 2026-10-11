import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { buildMetrics, tokens } from '../src/core/metrics.ts';
import type { GraphSnapshot, ToolCall } from '../src/core/types.ts';
import { buildApp } from '../src/server/app.ts';

const NOW = Date.parse('2026-10-11T12:30:00.000Z');
const call = (over: Partial<ToolCall>): ToolCall => ({
  at: '2026-10-11T10:05:00.000Z',
  tool: 'kc_track',
  conversationId: 'c1',
  argChars: 350,
  resultChars: 700,
  durationMs: 10,
  ok: true,
  error: null,
  nodesCreated: 1,
  nodesChanged: 0,
  hit: null,
  ...over,
});
const emptyGraph: GraphSnapshot = { conversations: [], concepts: [], visits: [] };

test('tokens are characters / 3.5, rounded up', () => {
  assert.equal(tokens(350), 100);
  assert.equal(tokens(1), 1);
});

test('token totals are characters / 3.5, split into written and read', () => {
  const m = buildMetrics([call({}), call({ at: '2026-10-11T10:40:00.000Z' }), call({ at: '2026-10-11T12:10:00.000Z', argChars: 700 })], emptyGraph, { period: '24h' }, NOW);
  assert.equal(m.tokens.written, 400);
  assert.equal(m.tokens.read, 600);
  assert.equal(m.tokens.calls, 3);
});

test('size series: graph size, cumulative tokens and tokens per new node at every call', () => {
  const v = (id: string, at: string, conversationId = 'c1') => ({ id, conversationId, conceptId: `k-${id}`, parentVisitId: null, at, hasDetail: true, sourceCount: 1 });
  const graph: GraphSnapshot = {
    conversations: [],
    concepts: [],
    visits: [v('a', '2026-10-11T10:04:00.000Z'), v('b', '2026-10-11T10:04:30.000Z'), v('x', '2026-10-11T10:50:00.000Z', 'c2')],
    
  };
  const calls = [
    call({ nodesCreated: 2 }),
    call({ at: '2026-10-11T10:30:00.000Z', tool: 'kc_recall', nodesCreated: 0 }),
    call({ at: '2026-10-11T11:00:00.000Z', conversationId: 'c2' }),
  ];
  const all = buildMetrics(calls, graph, { period: 'all' }, NOW).size;
  assert.deepEqual(all.map((p) => p.nodes), [2, 2, 3]);
  assert.deepEqual(all.map((p) => p.cumTokens), [300, 600, 900]);
  assert.deepEqual(all.map((p) => p.perNode), [150, null, 300]);
  const one = buildMetrics(calls, graph, { conversation: 'c2' }, NOW).size;
  assert.deepEqual(one, [{ nodes: 1, cumTokens: 300, perNode: 300 }]);
});

test('per-tool stats, errors, efficiency and memory hits', () => {
  const m = buildMetrics(
    [
      call({ nodesCreated: 2 }),
      call({ nodesCreated: 0 }), // re-sent nodes: a full rewrite
      call({ tool: 'kc_edit', nodesCreated: 0, nodesChanged: 1 }),
      call({ tool: 'kc_recall', hit: true, nodesCreated: 0 }),
      call({ tool: 'kc_recall', hit: false, nodesCreated: 0 }),
      call({ tool: 'kc_read', ok: false, error: 'boom', hit: false, nodesCreated: 0, durationMs: 90 }),
    ],
    emptyGraph,
    { period: 'all' },
    NOW,
  );
  const track = m.tools.find((t) => t.tool === 'kc_track')!;
  assert.equal(track.calls, 2);
  assert.equal(m.tools.find((t) => t.tool === 'kc_read')!.errors, 1);
  assert.equal(m.tools.find((t) => t.tool === 'kc_read')!.maxMs, 90);
  assert.equal(m.efficiency.nodesCreated, 2);
  assert.equal(m.efficiency.rewrites, 1);
  assert.equal(m.efficiency.partialEdits, 1);
  assert.equal(m.efficiency.tokensPerNode, Math.round((6 * (100 + 200)) / 2));
  assert.deepEqual(m.memory.recall, { calls: 2, hits: 1 });
  assert.deepEqual(m.memory.read, { calls: 1, hits: 0 });
});

test('conversation and period filters', () => {
  const calls = [call({}), call({ conversationId: 'c2' }), call({ at: '2026-10-01T10:00:00.000Z' })];
  assert.equal(buildMetrics(calls, emptyGraph, { conversation: 'c1' }, NOW).tokens.calls, 2);
  assert.equal(buildMetrics(calls, emptyGraph, { period: '24h' }, NOW).tokens.calls, 2);
  assert.equal(buildMetrics(calls, emptyGraph, { period: 'all', conversation: 'c2' }, NOW).tokens.calls, 1);
});

test('quality: missing detail / sources / superclass, duplicates, depth and branching', () => {
  const v = (id: string, parent: string | null, extra: object = {}) => ({
    id, conversationId: 'c1', conceptId: `k-${id}`, parentVisitId: parent, at: '2026-10-11T09:00:00.000Z', hasDetail: true, sourceCount: 1, ...extra,
  });
  const graph: GraphSnapshot = {
    conversations: [{ id: 'c1', at: '2026-10-11T09:00:00.000Z' }],
    concepts: [
      { id: 'k-a', name: 'Event sourcing', at: '2026-10-11T09:00:00.000Z', hasSuperclass: true },
      { id: 'k-b', name: 'Microservizi', at: '2026-10-11T09:00:00.000Z', hasSuperclass: false },
      { id: 'k-c', name: 'Event sourcing pattern', at: '2026-10-11T09:00:00.000Z', hasSuperclass: false },
    ],
    visits: [v('a', null), v('b', 'a', { hasDetail: false }), v('c', 'b', { sourceCount: 0 }), v('d', 'a')],
  };
  const m = buildMetrics([], graph, { period: 'all' }, NOW);
  assert.deepEqual(m.quality.depth, [1, 2, 1]);
  assert.equal(m.quality.maxDepth, 3);
  assert.equal(m.quality.avgChildren, 1.5); // a has 2 children, b has 1
  assert.equal(m.quality.withoutDetail, 1);
  assert.equal(m.quality.withoutSources, 1);
  assert.equal(m.quality.withoutSuperclass, 2);
  assert.deepEqual(m.quality.duplicates, [['Event sourcing', 'Event sourcing pattern']]);
});

// --- logging through the real MCP layer ---
const tracker = new Tracker(new SqliteRepository(':memory:'));
const app = await buildApp({ tracker });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

test('every MCP tool call is logged centrally with sizes, outcome and nodes created', async () => {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  await client.callTool({ name: 'kc_start', arguments: { title: 'Kafka' } });
  const nodes = [{ title: 'Kafka', summary: 'Log distribuito.', parent: 'root' }];
  await client.callTool({ name: 'kc_track', arguments: { nodes } });
  await client.callTool({ name: 'kc_track', arguments: { nodes } }); // same node again: nothing new
  await client.callTool({ name: 'kc_recall', arguments: { query: 'Kafka' } });
  await client.callTool({ name: 'kc_recall', arguments: { query: 'Zzzxyq' } });
  await client.callTool({ name: 'kc_focus', arguments: { node: 'Inesistente' } });
  await client.callTool({ name: 'kc_profile', arguments: {} });
  await client.close();

  const calls = tracker.repo.listToolCalls();
  assert.deepEqual(calls.map((c) => c.tool), ['kc_start', 'kc_track', 'kc_track', 'kc_recall', 'kc_recall', 'kc_focus', 'kc_profile']);
  assert.equal(calls[1].nodesCreated, 1);
  assert.equal(calls[2].nodesCreated, 0);
  assert.equal(calls[1].argChars, JSON.stringify({ nodes }).length);
  assert.ok(calls[1].resultChars > 0 && calls[1].durationMs >= 0);
  assert.deepEqual(calls.filter((c) => c.tool === 'kc_recall').map((c) => c.hit), [true, false]);
  assert.equal(calls[5].ok, false);
  assert.ok(calls[5].error);
  assert.equal(calls[6].argChars, 2); // tool without input: "{}"
  assert.ok(calls.slice(1).every((c) => c.conversationId));

  const res = await fetch(new URL('/api/metrics?period=24h', base));
  const m = await res.json();
  assert.equal(m.tokens.calls, 7);
  assert.equal(m.efficiency.nodesCreated, 1);
  assert.equal(m.efficiency.rewrites, 1);
  assert.equal(m.tools.find((t: { tool: string }) => t.tool === 'kc_focus').errors, 1);
  assert.equal(m.quality.nodes, 1);
});
