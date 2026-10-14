import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';

/** Two maps sharing the concepts Kafka and Offset; Solo lives only in A. */
function setup() {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const a = tracker.startConversation('A', null);
  const b = tracker.startConversation('B', null);
  const [kafka] = tracker.track(a.id, [{ title: 'Kafka', summary: 'Log in A.', parent: 'root', detail: 'Testo A' }]);
  const [offset] = tracker.track(a.id, [{ title: 'Offset', summary: 'Posizione in A.', parent: 'root' }]);
  const [solo] = tracker.track(a.id, [{ title: 'Solo A', summary: 'Solo qui.', parent: 'root' }]);
  tracker.track(b.id, [{ title: 'Kafka', summary: 'Log in B.', parent: 'root' }]);
  tracker.track(b.id, [{ title: 'Offset', summary: 'Posizione in B.', parent: 'root' }]);
  return { tracker, repo: tracker.repo, a, b, kafka, offset, solo };
}

test('a relation belongs to the map it was drawn in; the global graph shows the union, a pair once', () => {
  const { tracker, repo, a, b, kafka, offset } = setup();
  tracker.setRelation(kafka.conceptId, offset.conceptId, true, 'usa', a.id);
  assert.deepEqual(repo.getTree(a.id)!.relations, [{ from: kafka.conceptId, to: offset.conceptId, label: 'usa' }]);
  assert.deepEqual(repo.getTree(b.id)!.relations, [], 'both concepts are in B but the relation is not');
  assert.deepEqual(repo.listRelated(kafka.conceptId, b.id), []);
  assert.equal(repo.listRelated(kafka.conceptId).length, 1);

  // Drawn in B too (other direction): two maps, one edge in the global graph.
  tracker.setRelation(offset.conceptId, kafka.conceptId, true, null, b.id);
  assert.equal(repo.getTree(b.id)!.relations.length, 1);
  assert.equal(repo.getPersonalGraph().edges.filter((e) => e.relation).length, 1);
  assert.equal(new Reader(repo).conceptPage(kafka.conceptId, a.id)!.related[0].label, 'usa');
  assert.equal(new Reader(repo).conceptPage(kafka.conceptId, b.id)!.related[0].label, undefined);

  // Removing from one map leaves the other; without a map it clears all.
  tracker.setRelation(kafka.conceptId, offset.conceptId, false, undefined, a.id);
  assert.equal(repo.getTree(a.id)!.relations.length, 0);
  assert.equal(repo.getTree(b.id)!.relations.length, 1);
  assert.throws(() => tracker.setRelation(kafka.conceptId, offset.conceptId, false, undefined, a.id), /Relation not found/);
  tracker.setRelation(kafka.conceptId, offset.conceptId, false);
  assert.equal(repo.listRelated(kafka.conceptId).length, 0);
});

test('relations follow merges and go with their map or concept', () => {
  const { tracker, repo, a, b, kafka, offset, solo } = setup();
  tracker.setRelation(kafka.conceptId, offset.conceptId, true, null, a.id);
  tracker.setRelation(solo.conceptId, offset.conceptId, true, null, a.id);
  tracker.mergeConcepts(solo.conceptId, kafka.conceptId);
  // Solo -> Offset now repeats Kafka -> Offset: one relation is left, none joins a concept to itself.
  assert.equal(repo.getTree(a.id)!.relations.length, 1);

  tracker.deleteConversation(a.id);
  assert.equal(repo.getTree(b.id)!.relations.length, 0);
  assert.equal(repo.listRelated(kafka.conceptId).length, 0, 'the map took its relations with it');

  tracker.setRelation(kafka.conceptId, offset.conceptId, true, null, b.id);
  tracker.deleteConcept(offset.conceptId);
  assert.equal(repo.getTree(b.id)!.relations.length, 0);
});

test('old related links move to every map holding both concepts, once, and leave concept_links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-'));
  const path = join(dir, 'graph.db');
  const first = new SqliteRepository(path);
  const tracker = new Tracker(first);
  const a = tracker.startConversation('A', null);
  const b = tracker.startConversation('B', null);
  const c = tracker.startConversation('C', null);
  const ids: Record<string, string> = {};
  for (const [conv, titles] of [[a, ['X', 'Y']], [b, ['X', 'Y', 'Z']], [c, ['X']]] as const) {
    for (const t of titles) ids[t] = tracker.track(conv.id, [{ title: t, summary: t, parent: 'root' }])[0].conceptId;
  }
  first.close();

  // The old layout: a relation was a link between concepts, whichever maps held them.
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const ins = db.prepare(`INSERT INTO concept_links (from_concept_id, to_concept_id, kind, label, created_at) VALUES (?, ?, 'related', ?, 'now')`);
  ins.run(ids.X, ids.Y, 'usa'); // in A and B
  ins.run(ids.Y, ids.Z, null); // only in B
  ins.run(ids.X, ids.Z, 'solo'); // B only: Z is not in A or C
  db.prepare(`INSERT INTO concept_links (from_concept_id, to_concept_id, kind, created_at) VALUES (?, ?, 'is_a', 'now')`).run(ids.Y, ids.Z);
  db.close();

  for (let run = 0; run < 2; run++) {
    const repo = new SqliteRepository(path); // the second open must change nothing
    const rel = (id: string) => repo.getTree(id)!.relations.map((r) => `${r.from === ids.X ? 'X' : r.from === ids.Y ? 'Y' : 'Z'}-${r.to === ids.Y ? 'Y' : 'Z'}:${r.label ?? ''}`).sort();
    assert.deepEqual(rel(a.id), ['X-Y:usa']);
    assert.deepEqual(rel(b.id), ['X-Y:usa', 'X-Z:solo', 'Y-Z:']);
    assert.deepEqual(rel(c.id), []);
    assert.equal(repo.getSuperclass(ids.Y)?.id, ids.Z, 'superclass links stay global');
    assert.equal(repo.getPersonalGraph().edges.filter((e) => e.relation).length, 3);
    repo.close();
  }
  const check = new DatabaseSync(path);
  assert.equal(check.prepare(`SELECT COUNT(*) AS n FROM concept_links WHERE kind = 'related'`).get()!.n, 0);
  check.close();
});

test('no text of another map leaks through the core: link, relate and similar stay in the map', () => {
  const { tracker, a, b, solo, kafka } = setup();
  const [twin] = tracker.track(b.id, [{ title: 'Solo B', summary: 'x', parent: 'root' }]);
  assert.throws(() => tracker.link(b.id, twin.id, solo.conceptId), /not in this graph/);
  const [dup] = tracker.track(a.id, [{ title: 'Kafka bis', summary: 'x', parent: 'root' }]);
  assert.equal(tracker.link(a.id, dup.id, kafka.conceptId).conceptId, kafka.conceptId, 'Kafka is in A: allowed');
  // Similar lists only concepts with a node in this map.
  tracker.track(a.id, [{ title: 'Kafka streams', summary: 's', parent: 'root' }]);
  const [k] = tracker.track(b.id, [{ title: 'Kafka streams', summary: 's', parent: 'root' }]);
  assert.deepEqual(k.similar.map((m) => m.name), ['Kafka'], 'only Kafka has a node in B');
  const [fresh] = tracker.track(b.id, [{ title: 'Solo A2', summary: 's', parent: 'root' }]);
  assert.ok(!fresh.similar.some((m) => m.name === 'Solo A'), 'a concept only of another map is never offered');
});
