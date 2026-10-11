import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker, TrackerError, type TrackerEvent } from '../src/core/tracker.ts';
import { normalizeName } from '../src/core/normalize.ts';

const setup = () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const conv = tracker.startConversation('Kafka', null);
  return { tracker, conv };
};

test('normalizeName ignores case, accents and punctuation', () => {
  assert.equal(normalizeName('  Perché   Kafka?! '), 'perche kafka');
  assert.equal(normalizeName('Event-Sourcing'), normalizeName('event sourcing'));
});

test('drill-down hangs children under the current node', () => {
  const { tracker, conv } = setup();
  const [kafka] = tracker.track(conv.id, [{ title: 'Kafka', summary: 'Log distribuito.' }]);
  const [cg] = tracker.track(conv.id, [{ title: 'Consumer group', summary: 'Gruppi di consumer.' }]);
  const tree = tracker.repo.getTree(conv.id)!;
  assert.equal(tree.visits.find((v) => v.id === cg.id)!.parentVisitId, kafka.id);
  assert.equal(tree.conversation.currentVisitId, cg.id);
});

test('"root" starts a new branch and "#n" references the same batch', () => {
  const { tracker, conv } = setup();
  tracker.track(conv.id, [{ title: 'Kafka', summary: 's' }]);
  const res = tracker.track(conv.id, [
    { title: 'Event sourcing', summary: 's', parent: 'root' },
    { title: 'Snapshot', summary: 's', parent: '#0' },
    { title: 'Proiezioni', summary: 's', parent: '#0' },
  ]);
  const visits = tracker.repo.getTree(conv.id)!.visits;
  const byId = new Map(visits.map((v) => [v.id, v]));
  assert.equal(byId.get(res[0].id)!.parentVisitId, null);
  assert.equal(byId.get(res[1].id)!.parentVisitId, res[0].id);
  assert.equal(byId.get(res[2].id)!.parentVisitId, res[0].id);
});

test('a returning concept reuses the concept and is flagged as revisit (D1)', () => {
  const { tracker, conv } = setup();
  tracker.track(conv.id, [{ title: 'Kafka', summary: 's', parent: 'root' }]);
  const [a] = tracker.track(conv.id, [{ title: 'Partizioni', summary: 'prima', parent: 'Kafka' }]);
  const [b] = tracker.track(conv.id, [{ title: 'partizioni', summary: 'dopo', parent: 'root' }]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.conceptId, b.conceptId);
  assert.equal(b.knownConcept, true);
  assert.equal(b.revisit, true);
  assert.equal(tracker.repo.getConceptDetail(a.conceptId)!.visits.length, 2);
});

test('the personal graph spans conversations (D2)', () => {
  const { tracker, conv } = setup();
  const [a] = tracker.track(conv.id, [{ title: 'Partizioni', summary: 's' }]);
  const other = tracker.startConversation('Altro', null);
  const [b] = tracker.track(other.id, [{ title: 'Partizioni', summary: 's' }]);
  assert.equal(a.conceptId, b.conceptId);
  assert.equal(b.knownConcept, true);
  assert.equal(b.revisit, false);
});

test('new concepts come back with similar existing ones, and kc_link merges them', () => {
  const { tracker, conv } = setup();
  const [a] = tracker.track(conv.id, [{ title: 'Partizioni Kafka', summary: 's' }]);
  const [b] = tracker.track(conv.id, [{ title: 'Partizionamento Kafka', summary: 's' }]);
  assert.deepEqual(
    b.similar.map((s) => s.id),
    [a.conceptId],
  );
  tracker.link(conv.id, b.id, a.conceptId);
  assert.equal(tracker.repo.getVisit(b.id)!.conceptId, a.conceptId);
  assert.equal(tracker.repo.getConcept(b.conceptId), undefined, 'orphan concept is removed');
});

test('focus moves the current node; bad references are rejected without partial writes', () => {
  const { tracker, conv } = setup();
  const [kafka] = tracker.track(conv.id, [{ title: 'Kafka', summary: 's' }]);
  tracker.track(conv.id, [{ title: 'Offset', summary: 's' }]);
  tracker.focus(conv.id, kafka.id);
  const [p] = tracker.track(conv.id, [{ title: 'Partizioni', summary: 's' }]);
  assert.equal(tracker.repo.getVisit(p.id)!.parentVisitId, kafka.id);

  const before = tracker.repo.getTree(conv.id)!.visits.length;
  assert.throws(
    () => tracker.track(conv.id, [{ title: 'Ok', summary: 's' }, { title: 'Ko', summary: 's', parent: 'nope' }]),
    TrackerError,
  );
  assert.throws(() => tracker.track(conv.id, [{ title: 'X', summary: 's', parent: '#0' }]), TrackerError);
  assert.equal(tracker.repo.getTree(conv.id)!.visits.length, before);
});

test('nodes of another conversation cannot be used as parent', () => {
  const { tracker, conv } = setup();
  const other = tracker.startConversation('Altro', null);
  const [x] = tracker.track(other.id, [{ title: 'X', summary: 's' }]);
  assert.throws(() => tracker.track(conv.id, [{ title: 'Y', summary: 's', parent: x.id }]), TrackerError);
});

test('every change is emitted as an event', () => {
  const { tracker, conv } = setup();
  const events: TrackerEvent[] = [];
  tracker.events.on('change', (e) => events.push(e));
  tracker.track(conv.id, [
    { title: 'A', summary: 's' },
    { title: 'B', summary: 's' },
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['visit.created', 'visit.created', 'focus.changed'],
  );
});

test('same concept under the same parent updates the node; on another branch it is a revisit (D15, D1)', () => {
  const { tracker, conv } = setup();
  tracker.track(conv.id, [{ title: 'Annaffiatura', summary: 's', parent: 'root' }]);
  const [first] = tracker.track(conv.id, [{ title: 'Acqua giusta', summary: 'prima', parent: 'Annaffiatura' }]);
  const [again] = tracker.track(conv.id, [{ title: 'acqua giusta', summary: 'dopo', parent: 'annaffiatura' }]);
  assert.equal(again.id, first.id);
  assert.equal(again.updated, true);
  assert.equal(tracker.repo.getVisit(first.id)!.summary, 'dopo');

  const [elsewhere] = tracker.track(conv.id, [{ title: 'Acqua giusta', summary: 'altro ramo', parent: 'root' }]);
  assert.notEqual(elsewhere.id, first.id);
  assert.equal(elsewhere.revisit, true);
  assert.equal(tracker.repo.getTree(conv.id)!.visits.length, 3);
});

test('parents may come later in the same batch, by title or "#n"; results keep the caller order', () => {
  const { tracker, conv } = setup();
  const res = tracker.track(conv.id, [
    { title: 'Offset', summary: 's', parent: 'Consumer group' },
    { title: 'Rebalance', summary: 's', parent: '#2' },
    { title: 'Consumer group', summary: 's', parent: 'Kafka' },
    { title: 'Kafka', summary: 's', parent: 'root' },
  ]);
  const byId = new Map(tracker.repo.getTree(conv.id)!.visits.map((v) => [v.id, v]));
  assert.deepEqual(res.map((r) => byId.get(r.id)!.title), ['Offset', 'Rebalance', 'Consumer group', 'Kafka']);
  assert.equal(byId.get(res[0].id)!.parentVisitId, res[2].id);
  assert.equal(byId.get(res[1].id)!.parentVisitId, res[2].id);
  assert.equal(byId.get(res[2].id)!.parentVisitId, res[3].id);
  assert.equal(byId.get(res[3].id)!.parentVisitId, null);
  assert.equal(tracker.repo.getTree(conv.id)!.conversation.currentVisitId, res[3].id);
});

test('a parent cycle or any other error in a batch is refused and nothing is written', () => {
  const { tracker, conv } = setup();
  tracker.track(conv.id, [{ title: 'Kafka', summary: 's', parent: 'root' }]);
  const before = tracker.repo.getTree(conv.id)!.visits.length;
  const concepts = tracker.repo.countConcepts();
  assert.throws(
    () =>
      tracker.track(conv.id, [
        { title: 'Topic', summary: 's', parent: 'Kafka' },
        { title: 'A', summary: 's', parent: 'B' },
        { title: 'B', summary: 's', parent: '#1' },
      ]),
    /Parent cycle in this call: #1 "A" under #2 "B" under #1 "A"/,
  );
  assert.throws(() => tracker.track(conv.id, [{ title: 'C', summary: 's', parent: '#0' }]), /not another node/);
  // A later error (unknown parent) rolls back the nodes already added by the same call.
  assert.throws(
    () =>
      tracker.track(conv.id, [
        { title: 'Topic', summary: 's', parent: 'Kafka' },
        { title: 'D', summary: 's', parent: 'Missing' },
      ]),
    TrackerError,
  );
  assert.equal(tracker.repo.getTree(conv.id)!.visits.length, before);
  assert.equal(tracker.repo.countConcepts(), concepts);
});

test('deleting a conversation keeps concepts used elsewhere and drops the rest', () => {
  const { tracker, conv } = setup();
  const other = tracker.startConversation('Altro', null);
  tracker.track(conv.id, [{ title: 'Kafka', summary: 's' }, { title: 'Solo qui', summary: 's', parent: '#0' }]);
  tracker.track(other.id, [{ title: 'Kafka', summary: 's' }]);
  const events: TrackerEvent[] = [];
  tracker.events.on('change', (e) => events.push(e));
  tracker.deleteConversation(conv.id);
  const names = tracker.repo.getPersonalGraph().concepts.map((c) => c.name);
  assert.deepEqual(names, ['Kafka']);
  assert.equal(tracker.repo.getConversation(conv.id), undefined);
  assert.ok(tracker.repo.getConversation(other.id));
  assert.equal(events.at(-1)!.type, 'conversation.deleted');
  assert.throws(() => tracker.deleteConversation(conv.id), TrackerError);
});
