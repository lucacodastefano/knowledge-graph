import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { buildApp } from '../src/server/app.ts';
import { exportFileName } from '../src/server/export.ts';

/** A stand-in for web/dist with the same shape Vite writes (one module script, one stylesheet). */
function fakeWebRoot() {
  const root = mkdtempSync(join(tmpdir(), 'kg-export-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'index-abc.js'), 'window.__app = "$& </script> $1";');
  writeFileSync(join(root, 'assets', 'index-abc.css'), 'body{margin:0}');
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>Knowledge Graph</title><script type="module" crossorigin src="/assets/index-abc.js"></script>\n<link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>',
  );
  return root;
}

const snapshotOf = (html: string) => {
  const m = /<script type="application\/json" id="kg-snapshot">(.*?)<\/script>/s.exec(html);
  assert.ok(m, 'snapshot element present');
  return JSON.parse(m[1]);
};

test('the export holds the map alone: a second map sharing a concept does not leak into it', async () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const a = tracker.startConversation('Mappa <A> è', null);
  const b = tracker.startConversation('Mappa B', null);
  const [kafka] = tracker.track(a.id, [{ title: 'Kafka', summary: 'Log in A.', parent: 'root', detail: 'Dettaglio **A**', sources: ['https://kafka.apache.org/docs'] }]);
  const [offset] = tracker.track(a.id, [{ title: 'Offset', summary: 'Posizione in A.', parent: 'Kafka' }]);
  tracker.track(b.id, [{ title: 'Kafka', summary: 'SEGRETO-B nel riassunto.', parent: 'root', detail: 'SEGRETO-B nel dettaglio' }]);
  tracker.track(b.id, [{ title: 'Solo B', summary: 'SEGRETO-B nodo.', parent: 'root' }]);
  tracker.setRelation(kafka.conceptId, offset.conceptId, true, 'usa', a.id);
  tracker.repo.setLayout([
    { kind: 'visit', id: kafka.id, x: 10, y: 20 },
    { kind: 'visit', id: tracker.repo.getTree(b.id)!.visits[0].id, x: 99, y: 99 },
    { kind: 'relation', id: `r-${kafka.conceptId}-${offset.conceptId}`, x: 5, y: 6 },
  ]);
  const app = await buildApp({ tracker, webRoot: fakeWebRoot() });

  const res = await app.inject(`/api/conversations/${a.id}/export.html?layout=mindmap`);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/html/);
  assert.equal(res.headers['content-disposition'], 'attachment; filename="mappa-a-e.html"');
  const html = res.body;
  assert.ok(!html.includes('SEGRETO-B') && !html.includes('Solo B'), 'nothing of map B');
  assert.ok(!/src="\/assets|href="\/assets/.test(html), 'script and style are inlined');
  assert.ok(html.includes('window.__app = "$& <\\/script> $1";'), 'code inlined verbatim, </script> escaped');
  assert.ok(html.includes('<style>body{margin:0}</style>'));
  assert.match(html, /<title>Mappa &lt;A&gt; è<\/title>/);

  const snap = snapshotOf(html);
  assert.equal(snap.layoutKind, 'mindmap');
  assert.equal(snap.tree.visits.length, 2);
  assert.equal(snap.tree.relations.length, 1);
  assert.equal(snap.layout.length, 2, 'only the positions of this map');
  const page = snap.pages[kafka.conceptId];
  assert.equal(page.visits.length, 1, 'no occurrence from another map');
  assert.equal(page.visits[0].detail, 'Dettaglio **A**');
  assert.equal(page.visits[0].sections[0].title, 'Offset');
  assert.equal(page.sources.length, 1);
  assert.equal(page.related[0].label, 'usa');
  assert.equal(Object.keys(snap.pages).length, 2);

  assert.equal((await app.inject('/api/conversations/nope/export.html')).statusCode, 404);
  assert.equal((await app.inject(`/api/conversations/${a.id}/export.html?layout=evil`)).statusCode, 400);
});

test('the export needs the built canvas and the hosted-mode token', async () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const c = tracker.startConversation('X', null);
  const unbuilt = await buildApp({ tracker });
  const res = await unbuilt.inject(`/api/conversations/${c.id}/export.html`);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /npm run build:web/);

  const hosted = await buildApp({ tracker, webRoot: fakeWebRoot(), token: 'tok' });
  assert.equal((await hosted.inject(`/api/conversations/${c.id}/export.html`)).statusCode, 401);
  assert.equal((await hosted.inject({ url: `/api/conversations/${c.id}/export.html`, headers: { cookie: 'kg_token=tok' } })).statusCode, 200);
});

test('file names are ASCII slugs', () => {
  assert.equal(exportFileName('Perché Kafka? / Più veloce'), 'perche-kafka-piu-veloce.html');
  assert.equal(exportFileName('???'), 'grafo.html');
});
