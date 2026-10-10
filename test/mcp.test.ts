import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { buildApp, isAllowedOrigin } from '../src/server/app.ts';

const tracker = new Tracker(new SqliteRepository(':memory:'));
const app = await buildApp({ tracker });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

async function connect() {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  return client;
}

const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

test('exposes the tracking tools, the instructions prompt and server instructions', async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['kc_focus', 'kc_link', 'kc_start', 'kc_track']);
  assert.equal((await client.listPrompts()).prompts[0].name, 'kc_instructions');
  assert.match(client.getInstructions() ?? '', /kc_track/);
  await client.close();
});

test('a tracked conversation is readable through the REST API and pushed on the websocket', async () => {
  const client = await connect();
  const ws = new WebSocket(new URL('/ws', base.replace('http', 'ws')));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const received: string[] = [];
  ws.addEventListener('message', (m) => received.push(JSON.parse(String(m.data)).type));

  const { conversation } = json(await client.callTool({ name: 'kc_start', arguments: { title: 'Kafka' } }));
  const [root] = json(
    await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Kafka', summary: 'Log distribuito.' }] } }),
  );
  await client.callTool({
    name: 'kc_track',
    arguments: { nodes: [{ title: 'Consumer group', summary: 'Consumo in parallelo.' }] },
  });

  const tree = await (await fetch(new URL(`/api/conversations/${conversation}/tree`, base))).json();
  assert.equal(tree.visits.length, 2);
  assert.equal(tree.visits[1].parentVisitId, root.id);

  const concept = await (await fetch(new URL(`/api/concepts/${root.conceptId}`, base))).json();
  assert.equal(concept.visits[0].summary, 'Log distribuito.');

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(received.includes('visit.created'));
  assert.ok(received.includes('focus.changed'));
  ws.close();
  await client.close();
});

test('tracking without kc_start opens a conversation automatically', async () => {
  const client = await connect();
  const before = tracker.repo.listConversations().length;
  const res = await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Solo', summary: 's' }] } });
  assert.equal(res.isError, undefined);
  assert.equal(tracker.repo.listConversations().length, before + 1);
  await client.close();
});

test('domain errors come back as tool errors, not crashes', async () => {
  const client = await connect();
  const res = await client.callTool({ name: 'kc_focus', arguments: { node: 'missing' } });
  assert.equal(res.isError, true);
  await client.close();
});

test('only local origins are allowed', async () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  const res = await fetch(new URL('/api/conversations', base), { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});
