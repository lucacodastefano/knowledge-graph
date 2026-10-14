import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker, TrackerError, type TrackerEvent } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';

function setup() {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const a = tracker.startConversation('Kafka', null);
  const b = tracker.startConversation('Streaming', null);
  const [broker] = tracker.track(a.id, [{ title: 'Broker', summary: 'Server.', parent: 'root', detail: 'Testo del broker' }]);
  tracker.track(b.id, [{ title: 'Flink', summary: 'Engine.', parent: 'root', detail: 'Segreto di B' }]);
  return { tracker, repo: tracker.repo, a, b, broker };
}

test('a reference is a pair of nodes titled with the other graph, hidden from the global graph', () => {
  const { tracker, repo, a, b, broker } = setup();
  const events: TrackerEvent[] = [];
  tracker.events.on('change', (e: TrackerEvent) => events.push(e));
  const { visits, created } = tracker.createReference(a.id, b.id, 'Broker');
  assert.ok(created);
  const [src, back] = visits;
  assert.equal(src.title, 'Streaming');
  assert.equal(src.parentVisitId, broker.id);
  assert.deepEqual(src.ref, { visitId: back.id, conversationId: b.id, title: 'Streaming' });
  assert.equal(back.title, 'Kafka');
  const flink = repo.getTree(b.id)!.visits.find((v) => v.title === 'Flink')!;
  assert.equal(back.parentVisitId, flink.id, 'the return node hangs under the main node of the target graph');
  assert.equal(back.ref?.conversationId, a.id);
  assert.ok(events.some((e) => e.type === 'reference.created'));

  const g = repo.getPersonalGraph();
  assert.deepEqual(g.concepts.map((c) => c.name).sort(), ['Broker', 'Flink']);
  assert.equal(repo.countConcepts(), 2);
  assert.equal(repo.searchText('Streaming', 10).length, 0, 'references are not search hits');
  assert.equal(repo.graphSnapshot().visits.length, 2);

  // Asking again for the same link returns the existing pair.
  const again = tracker.createReference(a.id, b.id, 'Broker');
  assert.equal(again.created, false);
  assert.equal(again.visits[0].id, src.id);
  assert.throws(() => tracker.createReference(a.id, a.id), TrackerError);
});

test('deleting either node of a reference deletes both; deleting a graph drops the other end', () => {
  const { tracker, repo, a, b } = setup();
  const [src, back] = tracker.createReference(a.id, b.id).visits;
  const events: TrackerEvent[] = [];
  tracker.events.on('change', (e: TrackerEvent) => events.push(e));
  tracker.deleteVisit(back.id);
  assert.equal(repo.getVisit(src.id), undefined);
  assert.equal(repo.getVisit(back.id), undefined);
  assert.equal(events.filter((e) => e.type === 'visit.deleted').length, 2);

  const [src2] = tracker.createReference(a.id, b.id).visits;
  tracker.deleteConversation(b.id);
  assert.equal(repo.getVisit(src2.id), undefined, 'the node pointing to a deleted graph goes too');
  assert.ok(repo.getTree(a.id));
});

test('a reference cannot be edited or hold children, but can move', () => {
  const { tracker, a, b, broker } = setup();
  const [src] = tracker.createReference(a.id, b.id).visits;
  assert.throws(() => tracker.rename(a.id, src.id, 'Altro'), /reference/);
  assert.throws(() => tracker.editNode(a.id, src.id, { summary: 'x' }), /reference/);
  assert.throws(() => tracker.track(a.id, [{ title: 'Figlio', summary: 's', parent: src.id }]), /reference/);
  assert.throws(() => tracker.move(a.id, 'Broker', src.id), /reference/);
  assert.equal(tracker.move(a.id, src.id, 'Broker').parentVisitId, broker.id);
});

test('the model sees only the other graph title on a reference', () => {
  const { tracker, repo, a, b } = setup();
  tracker.createReference(a.id, b.id);
  const reader = new Reader(repo);
  const tree = reader.tree(a.id, true);
  assert.match(tree, /- ↗ Streaming/);
  assert.doesNotMatch(tree, /Segreto di B|Engine/);
  const read = reader.read(a.id, 'Streaming');
  assert.match(read, /Reference to the user's graph "Streaming"/);
  assert.doesNotMatch(read, /Segreto di B|Engine/);
  assert.deepEqual(reader.recall(a.id, 'Streaming'), []);
  assert.equal(Object.keys(reader.exportMap(a.id).pages).length, 1, 'no page for the reference node');
});

test('return nodes left at root level by older versions are hooked under the main node once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-'));
  const file = join(dir, 'g.db');
  const first = new Tracker(new SqliteRepository(file));
  const a = first.startConversation('Kafka', null);
  const b = first.startConversation('Streaming', null);
  first.track(b.id, [{ title: 'Flink', summary: 'Engine.', parent: 'root' }]);
  const [, back] = first.createReference(a.id, b.id).visits;
  const [, backA] = [null, first.repo.getVisit(back.id)!];
  first.repo.setVisitParent(backA.id, null);
  first.repo.setSetting('migrated_reference_roots', '');
  const repo = new SqliteRepository(file);
  const flink = repo.getTree(b.id)!.visits.find((v) => v.title === 'Flink')!;
  assert.equal(repo.getVisit(back.id)!.parentVisitId, flink.id);
  assert.equal(repo.getTree(a.id)!.visits.filter((v) => !v.parentVisitId).length, 1, 'a graph without a main node keeps its reference at root');
});
