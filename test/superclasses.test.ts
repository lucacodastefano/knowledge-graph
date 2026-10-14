import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';

function setup() {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const a = tracker.startConversation('A', null);
  const b = tracker.startConversation('B', null);
  const [ea] = tracker.track(a.id, [{ title: 'Enterprise architecture', summary: 'e' }]);
  const [sa] = tracker.track(b.id, [{ title: 'Solution architecture', summary: 's' }]);
  tracker.track(b.id, [{ title: 'Kafka', summary: 'k', parent: 'root' }]);
  return { tracker, repo: tracker.repo, a, b, ea, sa };
}

test('a superclass groups concepts, has no visits, appears in the personal graph and not in a map', () => {
  const { tracker, repo, a, ea, sa } = setup();
  const sup = tracker.group('Architettura IT', [ea.conceptId, sa.conceptId]);
  assert.equal(repo.countVisitsOfConcept(sup.id), 0);
  assert.deepEqual(repo.listMembers(sup.id).map((m) => m.id).sort(), [ea.conceptId, sa.conceptId].sort());
  const graph = repo.getPersonalGraph();
  assert.equal(graph.concepts.find((c) => c.id === ea.conceptId)!.superclassId, sup.id);
  assert.ok(graph.concepts.some((c) => c.id === sup.id), 'the visit-less superclass is a node');
  assert.equal(graph.edges.length, 0, 'grouping draws no edges: areas, not lines');
  const page = new Reader(repo).conceptPage(ea.conceptId)!;
  assert.equal(page.superclass?.name, 'Architettura IT');
  const inMap = new Reader(repo).conceptPage(ea.conceptId, a.id)!;
  assert.equal(inMap.superclass, null, 'superclasses are shown in the global graph only');
  assert.deepEqual(inMap.members, []);
  assert.deepEqual(new Reader(repo).profile().groups, ['Architettura IT (2)']);
});

test('one superclass per concept, no cycles, and an emptied superclass disappears', () => {
  const { tracker, repo, ea, sa } = setup();
  const it = tracker.group('Architettura IT', [ea.conceptId]);
  const inf = tracker.group('Informatica', [it.id]);
  assert.throws(() => tracker.setSuperclass(inf.id, ea.conceptId), /itself or one of its own members/);
  tracker.group('Architetture', [ea.conceptId]); // replaces, does not add
  assert.equal(repo.getSuperclass(ea.conceptId)!.name, 'Architetture');
  assert.equal(repo.getConcept(it.id), undefined, 'Architettura IT lost its last member');
  assert.equal(repo.getConcept(inf.id), undefined, 'and so did Informatica above it');
  tracker.setSuperclass(sa.conceptId, null);
});

test('deleting a node never deletes a superclass that still groups concepts', () => {
  const { tracker, repo, ea, sa } = setup();
  const sup = tracker.group('Arch', [ea.conceptId, sa.conceptId]);
  tracker.deleteConcept(ea.conceptId);
  assert.ok(repo.getConcept(sup.id));
  tracker.deleteConcept(sa.conceptId);
  assert.equal(repo.getConcept(sup.id), undefined);
});

test('merging keeps one superclass and refuses a loop', () => {
  const { tracker, repo, ea, sa } = setup();
  const x = tracker.group('X', [ea.conceptId]);
  tracker.group('Y', [sa.conceptId]);
  const merged = tracker.mergeConcepts(sa.conceptId, ea.conceptId);
  assert.equal(repo.getSuperclass(merged.id)!.id, x.id, 'the target keeps its own superclass');
  assert.equal(repo.getConcept(repo.findConceptByNorm('y')?.id ?? 'none'), undefined, 'the emptied Y is gone');
  const z = tracker.group('Z', [x.id]);
  assert.throws(() => tracker.mergeConcepts(z.id, merged.id), /loop/);
});

test('kc_relate by name: superclass (created if new) and a labelled relation of the current map', () => {
  const { tracker, repo, a, b, ea } = setup();
  tracker.track(a.id, [{ title: 'Kafka', summary: 'k', parent: 'root' }]);
  assert.match(tracker.relateByName(a.id, { concept: 'enterprise architecture', superclass: 'Architettura IT' }), /under "Architettura IT"/);
  assert.throws(() => tracker.relateByName(a.id, { concept: 'Nope', superclass: 'X' }), /not in this graph/);
  assert.throws(() => tracker.relateByName(a.id, { concept: 'Solution architecture', superclass: 'X' }), /not in this graph/, 'a concept only in another map');
  assert.throws(() => tracker.relateByName(a.id, { concept: 'Enterprise architecture', relatedTo: 'Solution architecture' }), /not in this graph/);
  tracker.relateByName(a.id, { concept: 'Enterprise architecture', relatedTo: 'Kafka', label: 'usa' });
  assert.deepEqual(repo.listRelated(ea.conceptId, a.id).map((r) => r.label), ['usa']);
  assert.equal(repo.getPersonalGraph().edges.find((e) => e.relation)!.label, 'usa');
  assert.equal(repo.getTree(b.id)!.relations.length, 0, 'Kafka is also in B but the relation was made in A');
  assert.equal(ea.conceptId, repo.findConceptByNorm('enterprise architecture')!.id);
});
