import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { applyDetailEdit } from '../src/core/node-edit.ts';
import { buildApp } from '../src/server/app.ts';

const tracker = new Tracker(new SqliteRepository(':memory:'));
const app = await buildApp({ tracker });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

async function connect() {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  return client;
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: textOf(r), isError: Boolean((r as { isError?: boolean }).isError) };
};

const DETAIL = '## Uno\nprimo testo\n\n### Sotto\nannidato\n\n## Due\nsecondo testo';

test('applyDetailEdit: replace once, append at the end or under a heading, clear errors', () => {
  assert.equal(applyDetailEdit('a b c', { find: 'b', replace: 'X' }), 'a X c');
  assert.equal(applyDetailEdit('a b c', { find: ' b', replace: '' }), 'a c');
  assert.throws(() => applyDetailEdit('a b c', { find: 'z', replace: 'X' }), /not found/);
  assert.throws(() => applyDetailEdit('a a', { find: 'a', replace: 'X' }), /2 times/);
  assert.throws(() => applyDetailEdit('a', { find: 'a' }), /needs replace/);
  assert.equal(applyDetailEdit(null, { append: 'nuovo' }), 'nuovo');
  assert.equal(applyDetailEdit(DETAIL, { append: 'in coda' }), `${DETAIL}\n\nin coda`);
  // Under "Uno": after its sub-section, before "Due".
  assert.equal(applyDetailEdit(DETAIL, { append: 'extra', under: 'uno' }), '## Uno\nprimo testo\n\n### Sotto\nannidato\n\nextra\n\n## Due\nsecondo testo');
  // Under "Sotto": the section ends at the next heading of the same or higher level.
  assert.match(applyDetailEdit(DETAIL, { append: 'extra', under: '### Sotto' }), /annidato\n\nextra\n\n## Due/);
  assert.throws(() => applyDetailEdit(DETAIL, { append: 'x', under: 'Tre' }), /heading "Tre" not found \(headings: Uno, Sotto, Due\)/);
  assert.throws(() => applyDetailEdit(DETAIL, { under: 'Uno' }), /under needs append/);
});

test('kc_edit changes only the asked part and keeps the rest', async () => {
  const c = await connect();
  await call(c, 'kc_start', { title: 'Edit prova' });
  await call(c, 'kc_track', {
    nodes: [{ title: 'Nodo', summary: 'Riassunto.', detail: 'Prima riga errata.\n\n## Parte\nTesto.', parent: 'root', sources: ['https://a.example/x'] }],
  });
  assert.match((await call(c, 'kc_edit', { node: 'Nodo', find: 'errata', replace: 'corretta' })).text, /Edited "Nodo": text replaced/);
  await call(c, 'kc_edit', { node: 'Nodo', append: 'Aggiunta.', under: 'Parte', summary: 'Nuovo riassunto.', add_sources: ['https://b.example/y'] });
  const read = (await call(c, 'kc_read', { node: 'Nodo' })).text;
  assert.match(read, /Nuovo riassunto\./);
  assert.match(read, /Prima riga corretta\.\n\n## Parte\nTesto\.\n\nAggiunta\./);
  assert.match(read, /Sources: https:\/\/a\.example\/x https:\/\/b\.example\/y|Sources: https:\/\/b\.example\/y https:\/\/a\.example\/x/);
  await call(c, 'kc_edit', { node: 'Nodo', remove_sources: ['https://a.example/x'] });
  assert.doesNotMatch((await call(c, 'kc_read', { node: 'Nodo' })).text, /a\.example/);

  for (const bad of [{ find: 'inesistente', replace: 'x' }, { under: 'Parte' }, {}, { remove_sources: ['https://nope.example'] }, { summary: ' ' }]) {
    assert.equal((await call(c, 'kc_edit', { node: 'Nodo', ...bad })).isError, true, JSON.stringify(bad));
  }
  assert.equal((await call(c, 'kc_edit', { node: 'Inesistente', summary: 'x' })).isError, true);
  // The old values are kept in the revision history (D16).
  const nodeId = tracker.repo.getTree(tracker.repo.listConversations()[0].id)!.visits[0].id;
  assert.ok(tracker.repo.listRevisions('visit', nodeId).some((r) => r.field === 'detail'));
  await c.close();
});

test('kc_start resumes a map with the same title, by id or title, and offers similar maps without creating an empty one', async () => {
  const c = await connect();
  const { text: first } = await call(c, 'kc_start', { title: 'Architettura event driven' });
  assert.doesNotMatch(first, /Resumed/);
  await call(c, 'kc_track', { nodes: [{ title: 'Evento', summary: 'Un fatto.', parent: 'root' }] });
  const before = tracker.repo.listConversations().length;

  // Same title (case and article folded): resumed, no new map.
  const again = await connect();
  const resumed = await call(again, 'kc_start', { title: 'architettura Event Driven' });
  assert.match(resumed.text, /Resumed the existing map "Architettura event driven"/);
  assert.match(resumed.text, /- Evento/);
  assert.equal(tracker.repo.listConversations().length, before);
  await call(again, 'kc_track', { nodes: [{ title: 'Broker', summary: 'Smista.', parent: 'Evento' }] });
  assert.equal(tracker.repo.getTree(tracker.repo.listConversations()[0].id)!.visits.length, 2, 'the node went into the resumed map');

  // Similar title: offered, nothing created yet; resume by title continues the right map.
  const similar = await connect();
  const offer = await call(similar, 'kc_start', { title: 'Event driven e Kafka' });
  assert.match(offer.text, /Similar maps: "Architettura event driven" \[[0-9a-f-]+\].*2 nodes/);
  assert.equal(tracker.repo.listConversations().length, before, 'no empty map is left while the model decides');
  assert.match((await call(similar, 'kc_start', { resume: 'event driven' })).text, /- Broker/);
  await call(similar, 'kc_track', { nodes: [{ title: 'Kafka', summary: 'Log.', parent: 'Broker' }] });
  assert.equal(tracker.repo.listConversations().length, before);

  // Ignoring the offer: the first kc_track creates the map with the title given to kc_start.
  const fresh = await connect();
  await call(fresh, 'kc_start', { title: 'Event driven e Kafka' });
  await call(fresh, 'kc_track', { nodes: [{ title: 'Altro', summary: 'x.', parent: 'root' }] });
  assert.equal(tracker.repo.listConversations()[0].title, 'Event driven e Kafka');
  assert.equal((await call(fresh, 'kc_start', { resume: 'zzz inesistente' })).isError, true);
  for (const x of [c, again, similar, fresh]) await x.close();
});

test('kc_track: at most 10 nodes per call, sources by reference inside the call', async () => {
  const c = await connect();
  await call(c, 'kc_start', { title: 'Limiti batch' });
  const many = Array.from({ length: 11 }, (_, i) => ({ title: `Nodo ${i}`, summary: 's.', parent: 'root' }));
  const big = await call(c, 'kc_track', { nodes: many });
  assert.equal(big.isError, true);
  assert.match(big.text, /11 nodes in one call, max 10/);
  assert.equal(tracker.repo.getTree(tracker.repo.listConversations()[0].id)!.visits.length, 0, 'nothing was saved');
  assert.equal((await call(c, 'kc_track', { nodes: many.slice(0, 10) })).isError, false);

  const shared = await call(c, 'kc_track', {
    nodes: [
      { title: 'Con fonte A', summary: 's.', parent: 'root', sources: ['@0', 'https://own.example/p'] },
      { title: 'Con fonte B', summary: 's.', parent: 'root', sources: ['@0'] },
    ],
    sources: ['https://shared.example/doc'],
  });
  assert.equal(shared.isError, false);
  const tree = tracker.repo.getTree(tracker.repo.listConversations()[0].id)!;
  const srcs = tree.visits.filter((v) => v.title.startsWith('Con fonte')).map((v) => v.sourceCount);
  assert.deepEqual(srcs, [2, 1]);
  const bad = await call(c, 'kc_track', { nodes: [{ title: 'X', summary: 's.', parent: 'root', sources: ['@3'] }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Source @3 is not in sources/);
  await c.close();
});
