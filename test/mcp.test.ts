import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
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
  assert.deepEqual(tools, ['kc_focus', 'kc_link', 'kc_move', 'kc_profile', 'kc_recall', 'kc_relate', 'kc_remove', 'kc_rename', 'kc_start', 'kc_track', 'kc_tree']);
  assert.equal((await client.listPrompts()).prompts[0].name, 'kc_instructions');
  assert.match(client.getInstructions() ?? '', /kc_track/);
  // Node texts are the answer's own sentences, not a summary of it.
  assert.match(client.getInstructions() ?? '', /not a summary.*exactly as you will write them; then use them verbatim/);
  const track = JSON.stringify((await client.listTools()).tools.find((t) => t.name === 'kc_track')!.inputSchema);
  assert.match(track, /word for word as you will write them/);
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
  assert.match((start.content as { text: string }[])[1].text, /^Tree: empty\n.*call kc_track first, then answer\. Silently/);
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Annaffiatura', summary: 'Quanta acqua.', parent: 'root' }] } });
  const res = await client.callTool({
    name: 'kc_track',
    arguments: { nodes: [{ title: 'Acqua giusta', summary: 'Né troppa né poca.', parent: 'root' }] },
  });
  const extra = (res.content as { text: string }[])[1].text;
  assert.match(extra, /^Tree:\n- Annaffiatura\n- Acqua giusta\n/);
  assert.match(extra, /never mention this call/);

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

test('detail is exposed only when the canvas turns it on, and Approfondisci shows sub-concepts as sections', async () => {
  const schemaOf = async (c: Client) =>
    JSON.stringify((await c.listTools()).tools.find((t) => t.name === 'kc_track')!.inputSchema);
  const off = await connect();
  assert.ok(!(await schemaOf(off)).includes('detail'));
  assert.ok(!(off.getInstructions() ?? '').includes('detail'));
  await off.close();

  const patch = (body: object) =>
    fetch(new URL('/api/settings', base), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual(await (await patch({ detail: true })).json(), { detail: true });
  const on = await connect();
  assert.ok((await schemaOf(on)).includes('detail'));
  assert.match(on.getInstructions() ?? '', /"detail"/);
  await on.close();
  await patch({ detail: false });

  const id = tracker.startConversation('Architettura', null).id;
  const [da] = tracker.track(id, [
    { title: 'Design Authority', summary: 'Organo di governo.', parent: 'root', detail: '- decide\n- verifica' },
    { title: 'Gate', summary: 'Punti di controllo.', parent: '#0' },
    { title: 'Gate di design', summary: 'Prima dello sviluppo.', parent: '#1' },
    { title: 'Deroghe', summary: 'Eccezioni motivate.', parent: '#0' },
  ]);
  const page = await (await fetch(new URL(`/api/concepts/${da.conceptId}`, base))).json();
  const [occ] = page.visits;
  assert.equal(occ.detail, '- decide\n- verifica');
  assert.equal(occ.parentTitle, null);
  assert.deepEqual(
    occ.sections.map((s: { title: string; children: { title: string }[] }) => [s.title, s.children.map((c) => c.title)]),
    [['Gate', ['Gate di design']], ['Deroghe', []]],
  );
});

test('kc_track accepts parents defined later in the call; any error says nothing was recorded', async () => {
  const client = await connect();
  try {
    await client.callTool({ name: 'kc_start', arguments: { title: 'Reti' } });
    const ok = await client.callTool({
      name: 'kc_track',
      arguments: { nodes: [{ title: 'Handshake', summary: 's', parent: 'TCP' }, { title: 'TCP', summary: 's', parent: 'root' }] },
    });
    assert.equal(ok.isError, undefined);
    assert.match((ok.content as { text: string }[])[1].text, /- TCP\n {2}- Handshake/);

    const cycle = await client.callTool({
      name: 'kc_track',
      arguments: { nodes: [{ title: 'UDP', summary: 's', parent: 'root' }, { title: 'A', summary: 's', parent: 'B' }, { title: 'B', summary: 's', parent: 'A' }] },
    });
    assert.equal(cycle.isError, true);
    assert.match((cycle.content as { text: string }[])[0].text, /Parent cycle.*Nothing was recorded\. Fix this and call kc_track again/);
    const tree = await client.callTool({ name: 'kc_tree', arguments: {} });
    assert.doesNotMatch((tree.content as { text: string }[])[0].text, /UDP/);
  } finally {
    await client.close();
  }
});

test('the detail setting reaches open sessions at once: tools/list_changed and a one-time note', async () => {
  const patch = (detail: boolean) =>
    fetch(new URL('/api/settings', base), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ detail }) });
  const client = await connect();
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changed++);
  const texts = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
  const track = (node: object) => client.callTool({ name: 'kc_track', arguments: { nodes: [{ summary: 's', parent: 'root', ...node }] } });
  try {
    await client.callTool({ name: 'kc_start', arguments: { title: 'Dettaglio live' } });
    await new Promise((r) => setTimeout(r, 50)); // the notification stream opens after initialization
    await patch(true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(changed, 1);
    const schema = JSON.stringify((await client.listTools()).tools.find((t) => t.name === 'kc_track')!.inputSchema);
    assert.match(schema, /"detail":\{[^}]*key points of your answer, one per line, word for word/);

    const first = await track({ title: 'Primo', detail: '- uno' });
    assert.match(texts(first), /Detail setting is now on/);
    const stored = tracker.repo.getVisit(json(first)[0].id)!;
    assert.equal(stored.detail, '- uno');
    assert.doesNotMatch(texts(await track({ title: 'Secondo' })), /Detail setting/);
    // A new chat in the same session (Claude Desktop) learns it from kc_start.
    assert.match(texts(await client.callTool({ name: 'kc_start', arguments: { title: 'Altra chat' } })), /Detail setting is now on/);

    await patch(false);
    const off = await track({ title: 'Terzo', detail: '- ignorato' });
    assert.match(texts(off), /Detail setting is now off/);
    assert.equal(tracker.repo.getVisit(json(off)[0].id)!.detail, null);
  } finally {
    await patch(false);
    await client.close();
  }
});
