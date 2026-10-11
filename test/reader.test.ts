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

test('recall finds a concept by name with notes, dates and neighbours', () => {
  const { reader } = setup();
  const [kafka] = reader.recall('kafka');
  assert.equal(kafka.name, 'Kafka');
  assert.equal(kafka.seen, 2);
  assert.match(kafka.last, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(kafka.notes, ['Usato come event store.', 'Log distribuito partizionato.']);
  assert.deepEqual(kafka.near.sort(), ['Consumer group', 'Event sourcing']);
});

test('recall also matches what was said, not only names', () => {
  const { reader } = setup();
  const names = reader.recall('partizioni').map((c) => c.name);
  assert.ok(names.includes('Consumer group'));
  assert.deepEqual(reader.recall('quantum computing'), []);
  assert.throws(() => reader.recall('  '), TrackerError);
});

test('tree is an indented outline without ids and with the current node', () => {
  const { tracker, reader, kafka } = setup();
  const outline = reader.tree(kafka.id, false).split('\n');
  assert.match(outline[0], /^Kafka \[.+\] \d{4}-\d{2}-\d{2}, 2 nodes$/);
  assert.equal(outline[1], `- Kafka`);
  assert.equal(outline[2], `  - Consumer group *current`);
  assert.match(reader.tree(kafka.id, true), /Consumer group .*: Consumer che si dividono/);
});

test('tree defaults to the latest conversation and reports unknown ids', () => {
  const { reader } = setup();
  assert.match(reader.tree(null, false), /^Event sourcing/);
  assert.throws(() => reader.tree('missing', false), TrackerError);
  assert.equal(new Reader(new SqliteRepository(':memory:')).tree(null, false), 'No conversations yet.');
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
