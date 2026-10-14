import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker, TrackerError } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';

const setup = () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const reader = new Reader(tracker.repo);
  const kafka = tracker.startConversation('Kafka', null);
  tracker.track(kafka.id, [{ title: 'Kafka', summary: 'Log distribuito partizionato.' }]);
  tracker.track(kafka.id, [{ title: 'Consumer group', summary: 'Consumer che si dividono le partizioni.' }]);
  const es = tracker.startConversation('Event sourcing', null);
  tracker.track(es.id, [{ title: 'Event sourcing', summary: 'Lo stato come sequenza di eventi.' }]);
  tracker.track(es.id, [{ title: 'Kafka', summary: 'Usato come event store.' }]);
  return { tracker, reader, kafka, es };
};

test('recall finds the nodes of the current map only, compact, without anything from other maps', () => {
  const { reader, kafka } = setup();
  const [node] = reader.recall(kafka.id, 'kafka');
  assert.deepEqual(node, { title: 'Kafka', summary: 'Log distribuito partizionato.', children: 1 });
  const [leaf] = reader.recall(kafka.id, 'consumer group');
  assert.deepEqual(leaf, { title: 'Consumer group', parent: 'Kafka', summary: 'Consumer che si dividono le partizioni.', thin: true });
  assert.ok(!JSON.stringify(reader.recall(kafka.id, 'kafka')).includes('event store'), 'the other map\'s text stays out');
});

test('recall also matches what was said, not only titles', () => {
  const { reader, kafka } = setup();
  const titles = reader.recall(kafka.id, 'partizioni').map((c) => c.title);
  assert.ok(titles.includes('Consumer group'));
  assert.deepEqual(reader.recall(kafka.id, 'quantum computing'), []);
  assert.deepEqual(reader.recall(kafka.id, 'sequenza di eventi'), [], 'that text is in another map');
  assert.throws(() => reader.recall(kafka.id, '  '), TrackerError);
});

test('searchGraphs looks only outside the current map, grouped by map, with summaries and no detail', () => {
  const { tracker, reader, kafka, es } = setup();
  tracker.track(es.id, [{ title: 'Store', summary: 'Dove stanno gli eventi.', detail: 'Testo lungo sui partizioni nascosto', parent: 'root' }]);
  const hits = reader.searchGraphs(kafka.id, 'kafka');
  assert.deepEqual(hits, [{ graph: 'Event sourcing', id: es.id, nodes: [{ title: 'Kafka', summary: 'Usato come event store.' }] }]);
  assert.ok(!JSON.stringify(reader.searchGraphs(kafka.id, 'nascosto')).includes('Testo lungo'));
  assert.deepEqual(reader.searchGraphs(es.id, 'consumer'), [{ graph: 'Kafka', id: kafka.id, nodes: [{ title: 'Consumer group', summary: 'Consumer che si dividono le partizioni.' }] }]);
  assert.deepEqual(reader.searchGraphs(es.id, 'quantum'), []);
});

test('read stays in the current map: a title only found elsewhere is an error, unless the other map is named', () => {
  const { reader, kafka, es } = setup();
  assert.throws(() => reader.read(kafka.id, 'Event sourcing'), /not in this graph/);
  assert.match(reader.read(es.id, 'Event sourcing'), /sequenza di eventi/);
  assert.match(reader.read(kafka.id, 'Consumer group'), /dividono le partizioni/);
  assert.match(reader.read(es.id, 'Kafka'), /event store/, 'a shared concept reads this map\'s text');
});

test('tree is an indented outline without ids and with the current node', () => {
  const { tracker, reader, kafka } = setup();
  const outline = reader.tree(kafka.id, false).split('\n');
  assert.match(outline[0], /^Kafka \[.+\] \d{4}-\d{2}-\d{2}, 2 nodes$/);
  assert.equal(outline[1], `- Kafka`);
  assert.equal(outline[2], `  - Consumer group *current`);
  assert.match(reader.tree(kafka.id, true), /Consumer group .*: Consumer che si dividono/);
});

test('tree reports unknown ids', () => {
  const { reader } = setup();
  assert.throws(() => reader.tree('missing', false), TrackerError);
});

test('profile lists top and recent concepts and non-empty conversations', () => {
  const { tracker, reader } = setup();
  tracker.startConversation('Vuota', null);
  const p = reader.profile();
  assert.equal(p.concepts, 3);
  assert.equal(p.top[0], 'Kafka ×2');
  assert.equal(p.recent.length, 3);
  assert.deepEqual(p.conversations.map((c) => c.title).sort(), ['Event sourcing', 'Kafka']);
});
