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
  const [a] = tracker.track(conv.id, [{ title: 'Partizioni', summary: 'prima' }]);
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
