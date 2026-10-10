import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker, type TrackerEvent } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';
import { buildApp } from '../src/server/app.ts';

function setup() {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const events: TrackerEvent[] = [];
  const c = tracker.startConversation('A', null);
  const [kafka, part, typo, offset] = tracker.track(c.id, [
    { title: 'Kafka', summary: 's' },
    { title: 'Partizioni', summary: 'p', parent: '#0' },
    { title: 'Partizoni', summary: 'dup', parent: '#1' },
    { title: 'Offset', summary: 'o', parent: '#2' },
  ]);
  tracker.events.on('change', (e) => events.push(e));
  return { tracker, repo: tracker.repo, c, kafka, part, typo, offset, events };
}

test('renaming a concept renames the nodes that used its name, not the reworded ones', () => {
  const { tracker, repo, c, typo } = setup();
  tracker.track(c.id, [{ title: 'partizoni', summary: 's', parent: 'root' }]);
  repo.setVisitTitle(repo.getTree(c.id)!.visits.at(-1)!.id, 'Partizioni sbagliate');
  const renamed = tracker.renameConcept(typo.conceptId, 'Partizione bis');
  assert.equal(renamed.name, 'Partizione bis');
  const titles = repo.getTree(c.id)!.visits.filter((v) => v.conceptId === typo.conceptId).map((v) => v.title);
  assert.deepEqual(titles, ['Partizione bis', 'Partizioni sbagliate']);
  assert.equal(repo.findConceptByNorm('partizione bis')?.id, typo.conceptId, 'the new name is what the model will match');
  assert.throws(() => tracker.renameConcept(typo.conceptId, 'kafka'), /merge/);
});

test('merging moves every visit to the target and drops the duplicate', () => {
  const { tracker, repo, part, typo, events } = setup();
  const into = tracker.mergeConcepts(typo.conceptId, part.conceptId);
  assert.equal(into.visitCount, 2);
  assert.equal(repo.getConcept(typo.conceptId), undefined);
  assert.ok(!new Reader(repo).search('partizoni').some((x) => x.id === typo.conceptId), 'the duplicate is gone from search too');
  assert.deepEqual(events.map((e) => e.type), ['concept.merged']);
  assert.throws(() => tracker.mergeConcepts(part.conceptId, part.conceptId), /itself/);
});

test('deleting a node moves its children up and drops a concept nobody uses', () => {
  const { tracker, repo, c, part, typo, offset } = setup();
  tracker.deleteVisit(typo.id);
  assert.equal(repo.getVisit(offset.id)!.parentVisitId, part.id);
  assert.equal(repo.getConcept(typo.conceptId), undefined);
  tracker.deleteVisit(offset.id);
  assert.equal(repo.getConversation(c.id)!.currentVisitId, part.id, 'focus falls back to the parent');
});

test('deleting a concept removes all its nodes in every conversation', () => {
  const { tracker, repo, c, kafka, part } = setup();
  const b = tracker.startConversation('B', null);
  tracker.track(b.id, [{ title: 'Partizioni', summary: 's' }, { title: 'ISR', summary: 's', parent: '#0' }]);
  tracker.deleteConcept(part.conceptId);
  assert.equal(repo.getConcept(part.conceptId), undefined);
  assert.equal(repo.getTree(c.id)!.visits.length, 3);
  const isr = repo.getTree(b.id)!.visits[0];
  assert.equal(isr.title, 'ISR');
  assert.equal(isr.parentVisitId, null);
  assert.equal(repo.getTree(c.id)!.visits.find((v) => v.title === 'Partizoni')!.parentVisitId, kafka.id);
});

test('a node can be renamed, moved and relinked, never under its own descendants', () => {
  const { tracker, repo, kafka, part, typo, offset } = setup();
  const moved = tracker.editVisit(offset.id, { title: 'Offset dei consumer', parentVisitId: kafka.id });
  assert.equal(moved.title, 'Offset dei consumer');
  assert.equal(moved.parentVisitId, kafka.id);
  assert.throws(() => tracker.editVisit(part.id, { parentVisitId: typo.id }), /descendants/);
  assert.equal(tracker.editVisit(part.id, { parentVisitId: null }).parentVisitId, null);
  tracker.editVisit(typo.id, { conceptId: part.conceptId });
  assert.equal(repo.getConcept(typo.conceptId), undefined, 'the orphaned duplicate is dropped');
});

test('search finds concepts by any part of the name, then by what was said', () => {
  const { tracker, c } = setup();
  tracker.track(c.id, [{ title: 'Consumer group', summary: 'Ogni partizione letta da un membro.' }]);
  const names = (q: string) => new Reader(tracker.repo).search(q).map((x) => x.name);
  assert.deepEqual(names('ka'), ['Kafka']);
  assert.equal(names('membro')[0], 'Consumer group');
  assert.deepEqual(names('  '), []);
});

test('REST: corrections and search over HTTP, with clear errors', async () => {
  const { tracker, part, typo, offset, events } = setup();
  const app = await buildApp({ tracker });
  const call = (method: 'GET' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload });

  assert.equal((await call('GET', '/api/search?q=parti')).json().length, 2);
  assert.equal((await call('PATCH', `/api/concepts/${typo.conceptId}`, { name: 'Kafka' })).statusCode, 409);
  assert.equal((await call('PATCH', '/api/concepts/nope', { name: 'X' })).statusCode, 404);
  assert.equal((await call('PATCH', `/api/visits/${offset.id}`, { title: 'Offset 2' })).json().title, 'Offset 2');
  assert.equal((await call('PATCH', `/api/concepts/${part.conceptId}`, {})).statusCode, 400);
  assert.equal((await call('POST', `/api/concepts/${typo.conceptId}/merge`, { into: part.conceptId })).json().visitCount, 2);
  assert.equal((await call('DELETE', `/api/visits/${offset.id}`)).statusCode, 204);
  assert.equal((await call('DELETE', `/api/concepts/${part.conceptId}`)).statusCode, 204);
  assert.deepEqual(events.map((e) => e.type), ['visit.updated', 'concept.merged', 'visit.deleted', 'concept.deleted']);
  await app.close();
});
