import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restatesParent, similarityKey } from '../src/core/similarity.ts';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';

test('similarityKey folds plurals, articles and word order', () => {
  assert.equal(similarityKey('Diagramma dei dati'), similarityKey('Diagrammi di dati'));
  assert.equal(similarityKey('Integrazione di sistemi'), similarityKey('Sistemi: integrazione'));
  assert.notEqual(similarityKey('Diagramma dei dati'), similarityKey('Diagramma di flusso'));
});

test('restatesParent catches wrapper nodes but not real parts', () => {
  assert.ok(restatesParent("Aspetti dell'integrazione tra sistemi", 'Integrazione di sistemi', false));
  assert.ok(restatesParent('Integrazione dei sistemi', 'Integrazione di sistemi', false));
  assert.ok(restatesParent('Overview of Kafka', 'Kafka', false));
  assert.ok(restatesParent('Design Authority', 'Design Authority e governance', true));
  assert.ok(!restatesParent('Design Authority', 'Design Authority e governance', false));
  assert.ok(!restatesParent('Kafka Streams', 'Kafka', true));
  assert.ok(!restatesParent('Latenza', 'Integrazione di sistemi', false));
  assert.ok(!restatesParent('Principi', 'Design Authority', false));
});

test('a part of the parent title with siblings in the same call is a real split', () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const conv = tracker.startConversation('Requisiti', null);
  tracker.track(conv.id, [{ title: 'Requisiti funzionali e non funzionali', summary: 's', parent: 'root' }]);
  const res = tracker.track(conv.id, [
    { title: 'Requisiti funzionali', summary: 's', parent: 'Requisiti funzionali e non funzionali' },
    { title: 'Casi d\'uso', summary: 's', parent: '#0' },
    { title: 'Requisiti non funzionali', summary: 's', parent: 'Requisiti funzionali e non funzionali' },
  ]);
  assert.equal(res.length, 3);
});

test('kc_track reports near-duplicate concepts first', () => {
  const tracker = new Tracker(new SqliteRepository(':memory:'));
  const conv = tracker.startConversation('Diagrammi', null);
  tracker.track(conv.id, [{ title: 'Diagrammi di dati', summary: 's', parent: 'root' }]);
  const [res] = tracker.track(conv.id, [{ title: 'Diagramma dei dati', summary: 's', parent: 'root' }]);
  assert.equal(res.similar[0].name, 'Diagrammi di dati');
});
