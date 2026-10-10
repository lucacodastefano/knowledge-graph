import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';
import { normalizeSourceUrl, normalizeSources, MAX_SOURCES_PER_NODE } from '../src/core/sources.ts';
import { buildApp } from '../src/server/app.ts';

const setup = () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const reader = new Reader(tracker.repo);
  const conv = tracker.startConversation('Kafka', null);
  return { tracker, reader, conv };
};

test('source URLs are normalized and invalid ones dropped', () => {
  assert.deepEqual(normalizeSourceUrl(' https://www.Example.com/a/?utm_source=x&id=2#top '), {
    url: 'https://www.example.com/a?id=2',
    domain: 'example.com',
  });
  assert.equal(normalizeSourceUrl('https://kafka.apache.org/')?.url, 'https://kafka.apache.org');
  assert.equal(normalizeSourceUrl('javascript:alert(1)'), null);
  assert.equal(normalizeSourceUrl('not a url'), null);
  const many = Array.from({ length: 20 }, (_, i) => `https://e.com/${i}`);
  assert.equal(normalizeSources(['https://e.com/a', 'https://e.com/a/', 42, ...many]).length, MAX_SOURCES_PER_NODE);
});

test('sources are stored once per URL, added on re-track and shown on the concept page', () => {
  const { tracker, reader, conv } = setup();
  const [kafka] = tracker.track(conv.id, [{ title: 'Kafka', summary: 's', sources: ['https://kafka.apache.org/', 'ftp://x'] }]);
  assert.equal(tracker.repo.getVisit(kafka.id)!.sourceCount, 1);
  // Same concept tracked again under the same parent: the new source joins the old one.
  tracker.track(conv.id, [{ title: 'Kafka', summary: 's2', parent: 'root', sources: ['https://kafka.apache.org', 'https://wikipedia.org/wiki/Kafka'] }]);
  const other = tracker.startConversation('Event sourcing', null);
  tracker.track(other.id, [{ title: 'Kafka', summary: 's', sources: ['https://kafka.apache.org?utm_medium=a'] }]);

  const page = reader.conceptPage(kafka.conceptId)!;
  assert.deepEqual(page.sources.map((s) => s.domain).sort(), ['kafka.apache.org', 'wikipedia.org']);
  assert.equal(page.sources.find((s) => s.domain === 'kafka.apache.org')!.visitIds.length, 2);
  assert.equal(reader.recall('Kafka')[0].sources?.length, 2);
  assert.equal(tracker.repo.getPersonalGraph().concepts[0].sourceCount, 2);
});

test('removing a source or its last node drops it when nothing cites it', async () => {
  const { tracker, reader, conv } = setup();
  const [a] = tracker.track(conv.id, [{ title: 'Kafka', summary: 's', sources: ['https://a.com', 'https://b.com'] }]);
  const app = await buildApp({ tracker });
  const [b] = reader.conceptPage(a.conceptId)!.sources.filter((s) => s.domain === 'b.com');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/visits/${a.id}/sources/${b.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/visits/${a.id}/sources/${b.id}` })).statusCode, 404);
  assert.deepEqual(reader.conceptPage(a.conceptId)!.sources.map((s) => s.domain), ['a.com']);
  tracker.deleteVisit(a.id);
  assert.equal(tracker.repo.listConceptSources(a.conceptId).length, 0);
  await app.close();
});
