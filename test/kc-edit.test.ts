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
  assert.match(resumed.text, /Resumed the existing graph "Architettura event driven"/);
  assert.match(resumed.text, /- Evento/);
  assert.equal(tracker.repo.listConversations().length, before);
  await call(again, 'kc_track', { nodes: [{ title: 'Broker', summary: 'Smista.', parent: 'Evento' }] });
  assert.equal(tracker.repo.getTree(tracker.repo.listConversations()[0].id)!.visits.length, 2, 'the node went into the resumed map');

  // Similar title: offered, nothing created yet; resume by title continues the right map.
  const similar = await connect();
  const offer = await call(similar, 'kc_start', { title: 'Event driven e Kafka' });
  assert.match(offer.text, /Similar graphs: "Architettura event driven" \[[0-9a-f-]+\].*2 nodes/);
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

test('searchText finds words inside the full detail of any map, follows edits and deletions', () => {
  const t = new Tracker(new SqliteRepository(':memory:'));
  const a = t.startConversation('Kafka', null);
  const b = t.startConversation('Eventi', null);
  t.track(a.id, [{ title: 'Partizioni', summary: 'Unità di parallelismo.', detail: 'Ogni partizione ha un leader; la replica garantisce la durabilità.', parent: 'root' }]);
  t.track(b.id, [{ title: 'Replicazione', summary: 'Copie dei dati.', detail: 'Il quorum decide la durabilità.', parent: 'root' }]);
  const titles = (q: string) => t.repo.searchText(q, 10).map((h) => `${h.conversationTitle}/${h.title}/${h.field}`);
  assert.deepEqual(titles('durabilità').sort(), ['Eventi/Replicazione/detail', 'Kafka/Partizioni/detail']);
  assert.deepEqual(titles('durabilita quorum'), ['Eventi/Replicazione/detail'], 'all words, accents folded');
  assert.match(t.repo.searchText('leader', 5)[0].snippet, /Ogni partizione ha un leader/);
  assert.equal(titles('partizioni')[0], 'Kafka/Partizioni/title', 'a title match ranks first');
  assert.deepEqual(titles('quorum durabilità leader').length, 2, 'falls back to any word when none has all');
  assert.deepEqual(titles('zz'), []);
  t.editNode(a.id, 'Partizioni', { find: 'leader', replace: 'coordinatore' });
  assert.deepEqual(titles('leader'), []);
  assert.deepEqual(titles('coordinatore'), ['Kafka/Partizioni/detail']);
  t.deleteConversation(b.id);
  assert.deepEqual(titles('quorum'), []);
});

test('the text index is built from existing nodes when a database from before it is opened', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(`${tmpdir()}/kg-fts-`);
  try {
    const path = `${dir}/graph.db`;
    const t1 = new Tracker(new SqliteRepository(path));
    const c = t1.startConversation('Vecchia', null);
    t1.track(c.id, [{ title: 'Nodo', summary: 's.', detail: 'testo antico indicizzabile', parent: 'root' }]);
    t1.repo.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TRIGGER visits_fts_ai; DROP TRIGGER visits_fts_ad; DROP TRIGGER visits_fts_au; DROP TABLE visits_fts;');
    raw.close();
    const t2 = new Tracker(new SqliteRepository(path));
    assert.equal(t2.repo.searchText('indicizzabile', 5).length, 1);
    t2.repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a big outline is cut by depth and a branch can be opened (kc_tree node / depth)', async () => {
  const { Reader, TREE_MAX_NODES } = await import('../src/core/reader.ts');
  const t = new Tracker(new SqliteRepository(':memory:'));
  const reader = new Reader(t.repo);
  const c = t.startConversation('Grande', null);
  // 5 branches of 3 levels: 5 + 5*6 + 5*6*6 = 215 nodes, over the cap.
  const names = (i: number) => `n${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${Math.floor(i / 676)}x`;
  let n = 0;
  const add = (parent: string, kids: number, depth: number) => {
    for (let k = 0; k < kids; k++) {
      const title = `Concetto ${names(n++)}`;
      t.track(c.id, [{ title, summary: 's.', parent }]);
      if (depth > 1) add(title, 6, depth - 1);
    }
  };
  add('root', 5, 3);
  const total = t.repo.getTree(c.id)!.visits.length;
  assert.ok(total > TREE_MAX_NODES);
  const cut = reader.tree(c.id, false, true);
  assert.match(cut, new RegExp(`Showing \\d+ of ${total} nodes`));
  assert.match(cut, /\(\+\d+\)/);
  assert.ok(cut.split('\n').length < total);
  // The ceiling holds even with a big depth; a branch is outlined from its own root.
  const deep = reader.tree(c.id, false, true, undefined, { depth: 99 });
  assert.ok(deep.split('\n').length <= TREE_MAX_NODES + 3);
  assert.match(deep, /Showing/);
  const branch = reader.tree(c.id, false, true, undefined, { root: 'Concetto naa0x' });
  assert.match(branch, /^Tree:\n- Concetto naa0x\n {2}- /);
  assert.ok(branch.split('\n').length < 60);
  assert.throws(() => reader.tree(c.id, false, true, undefined, { root: 'Inesistente' }), /not found/);
  // kc_tree orients on a big map: two levels, collapsed branches counted; a small map is shown whole.
  const oriented = reader.tree(c.id, false, false, undefined, { orient: true });
  assert.match(oriented, /Concetto nba0x \(\+6\)/);
  assert.ok(oriented.split('\n').length < 45);
  assert.match(oriented, /kc_tree\(root:/);
  // Small outlines are untouched.
  assert.doesNotMatch(reader.tree(c.id, false, true, undefined, { root: 'Concetto naa0x', depth: 1 }), /Showing 1 of 1/);
});
