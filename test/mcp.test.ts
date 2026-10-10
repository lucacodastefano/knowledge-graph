import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
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
  assert.deepEqual(tools, ['kc_focus', 'kc_link', 'kc_move', 'kc_profile', 'kc_recall', 'kc_remove', 'kc_rename', 'kc_start', 'kc_track', 'kc_tree']);
  assert.equal((await client.listPrompts()).prompts[0].name, 'kc_instructions');
  assert.match(client.getInstructions() ?? '', /kc_track/);
  const skill = readFileSync(new URL('../skills/knowledge-graph/SKILL.md', import.meta.url), 'utf8');
  for (const tool of tools) assert.ok(skill.includes(`\`${tool}\``), `skill should cover ${tool}`);
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
    await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Kafka', summary: 'Log distribuito.', parent: 'root' }] } }),
  );
  await client.callTool({
    name: 'kc_track',
    arguments: { nodes: [{ title: 'Consumer group', summary: 'Consumo in parallelo.', parent: 'kafka' }] },
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
  const res = await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Solo', summary: 's', parent: 'root' }] } });
  assert.equal(res.isError, undefined);
  assert.equal(tracker.repo.listConversations().length, before + 1);
  await client.close();
});

test('read tools answer from the graph without writing to it', async () => {
  const client = await connect();
  await client.callTool({ name: 'kc_start', arguments: { title: 'Rust' } });
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Borrow checker', summary: 'Regole di prestito.', parent: 'root' }] } });
  const before = tracker.repo.countConcepts();

  const [recalled] = json(await client.callTool({ name: 'kc_recall', arguments: { query: 'borrow checker' } }));
  assert.equal(recalled.name, 'Borrow checker');
  assert.deepEqual(recalled.notes, ['Regole di prestito.']);

  const tree = await client.callTool({ name: 'kc_tree', arguments: {} });
  assert.match((tree as { content: { text: string }[] }).content[0].text, /^Rust .*\n- Borrow checker \[.+\] \*current$/);

  const profile = json(await client.callTool({ name: 'kc_profile', arguments: {} }));
  assert.ok(profile.recent.includes('Borrow checker'));
  assert.equal(tracker.repo.countConcepts(), before);
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

test('kc_track returns the tree and a reminder; parents and kc_move work by title, without merging', async () => {
  const client = await connect();
  const start = await client.callTool({ name: 'kc_start', arguments: { title: 'Piante' } });
  assert.equal((start.content as { text: string }[])[1].text, 'Tree: empty');
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Annaffiatura', summary: 'Quanta acqua.', parent: 'root' }] } });
  const res = await client.callTool({
    name: 'kc_track',
    arguments: { nodes: [{ title: 'Acqua giusta', summary: 'Né troppa né poca.', parent: 'root' }] },
  });
  const extra = (res.content as { text: string }[])[1].text;
  assert.match(extra, /^Tree:\n- Annaffiatura\n- Acqua giusta\n/);
  assert.match(extra, /do not repeat/);

  const moved = await client.callTool({ name: 'kc_move', arguments: { node: 'Acqua giusta', parent: 'Annaffiatura' } });
  assert.match((moved.content as { text: string }[])[0].text, /- Annaffiatura\n {2}- Acqua giusta/);
  assert.equal(tracker.repo.listConversations().length > 0, true);
  const cycle = await client.callTool({ name: 'kc_move', arguments: { node: 'Annaffiatura', parent: 'Acqua giusta' } });
  assert.equal(cycle.isError, true);
  const missing = await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'X', summary: 's', parent: 'Nope' }] } });
  assert.equal(missing.isError, true);
  await client.close();
});

test("Luca's case: wrappers are refused, and an existing wrapper is dissolved by kc_remove in one call each", async () => {
  const client = await connect();
  await client.callTool({ name: 'kc_start', arguments: { title: 'Solution architecture' } });
  const track = (nodes: object[]) => client.callTool({ name: 'kc_track', arguments: { nodes } });
  await track([
    { title: 'Integrazione di sistemi', summary: 's', parent: 'root' },
    { title: 'Design Authority e governance', summary: 's', parent: 'root' },
  ]);
  const wrapper = await track([
    { title: "Aspetti dell'integrazione tra sistemi", summary: 's', parent: 'Integrazione di sistemi' },
    { title: 'Latenza', summary: 's', parent: '#0' },
  ]);
  assert.equal(wrapper.isError, true);
  assert.match((wrapper.content as { text: string }[])[0].text, /directly under "Integrazione di sistemi"/);
  const nested = await track([
    { title: 'Design Authority', summary: 's', parent: 'Design Authority e governance' },
    { title: 'Gate', summary: 's', parent: '#0' },
  ]);
  assert.equal(nested.isError, true);

  // Wrappers left by an older version: build them through the canvas corrections, then fix the hierarchy.
  const id = tracker.repo.listConversations().find((c) => c.title === 'Solution architecture')!.id;
  const [aspects] = tracker.track(id, [{ title: 'Aspetti', summary: 's', parent: 'root' }]);
  tracker.track(id, [{ title: 'Latenza', summary: 's', parent: 'Aspetti' }, { title: 'Accoppiamento', summary: 's', parent: 'Aspetti' }]);
  tracker.move(id, aspects.id, 'Integrazione di sistemi');
  tracker.track(id, [{ title: 'Governance board', summary: 's', parent: 'root' }, { title: 'Deroghe', summary: 's', parent: '#0' }]);
  tracker.move(id, 'Governance board', 'Design Authority e governance');

  await client.callTool({ name: 'kc_remove', arguments: { node: 'Aspetti' } });
  const fixed = await client.callTool({ name: 'kc_remove', arguments: { node: 'Governance board' } });
  assert.equal(
    (fixed.content as { text: string }[])[0].text.replace(/ \[.+?\]| \*current/g, '').split('\n').slice(1).join('\n'),
    ['- Integrazione di sistemi', '  - Latenza', '  - Accoppiamento', '- Design Authority e governance', '  - Deroghe'].join('\n'),
  );

  const renamed = await client.callTool({ name: 'kc_rename', arguments: { node: 'Deroghe', title: 'Deroghe ai principi' } });
  assert.match((renamed.content as { text: string }[])[0].text, /- Deroghe ai principi/);
  await client.close();
});
