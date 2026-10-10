import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';

test('the personal graph merges concepts and drill-downs across conversations (D2, D9)', () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const a = tracker.startConversation('A', null);
  tracker.track(a.id, [
    { title: 'Kafka', summary: 'vecchio' },
    { title: 'Partizioni', summary: 's', parent: '#0' },
  ]);
  const b = tracker.startConversation('B', null);
  tracker.track(b.id, [
    { title: 'Kafka', summary: 'nuovo' },
    { title: 'Partizioni', summary: 's', parent: '#0' },
    { title: 'Offset', summary: 's', parent: '#0' },
  ]);

  const g = tracker.repo.getPersonalGraph();
  const byName = new Map(g.concepts.map((c) => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ['Kafka', 'Offset', 'Partizioni']);
  assert.equal(byName.get('Kafka')!.visitCount, 2);
  assert.equal(byName.get('Kafka')!.summary, 'nuovo', 'preview shows the latest summary');

  const edge = g.edges.find((e) => e.source === byName.get('Kafka')!.id && e.target === byName.get('Partizioni')!.id);
  assert.equal(edge?.weight, 2, 'the same drill-down in two conversations is one weighted edge');
  assert.equal(g.edges.length, 2);
});

test('returning to a concept under itself creates no self-loop', () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const c = tracker.startConversation('A', null);
  tracker.track(c.id, [
    { title: 'Kafka', summary: 's' },
    { title: 'kafka', summary: 's', parent: '#0' },
  ]);
  assert.equal(tracker.repo.getPersonalGraph().edges.length, 0);
});

test('builds a 10k-concept graph fast enough for the canvas (RNF7)', () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const c = tracker.startConversation('Grande', null);
  for (let i = 0; i < 100; i++) {
    tracker.track(
      c.id,
      Array.from({ length: 100 }, (_, j) => ({ title: `Concetto ${i}-${j}`, summary: 's', parent: j === 0 ? 'root' : '#0' })),
    );
  }
  const t0 = performance.now();
  const g = tracker.repo.getPersonalGraph();
  const ms = performance.now() - t0;
  assert.equal(g.concepts.length, 10_000);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});
