import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';

test('after a checkpoint graph.db alone holds the data, while the daemon keeps it open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-'));
  const repo = new SqliteRepository(join(dir, 'graph.db'));
  const tracker = new Tracker(repo);
  tracker.track(tracker.startConversation('Piante', null).id, [{ title: 'Luce', summary: 'Quanta luce.' }]);
  repo.checkpoint();

  copyFileSync(join(dir, 'graph.db'), join(dir, 'backup.db'));
  const backup = new DatabaseSync(join(dir, 'backup.db'));
  assert.deepEqual(backup.prepare('SELECT name FROM concepts').all().map((r) => r.name), ['Luce']);
  backup.close();
  repo.close();
});

test('canvas positions and relation bends are stored, updated and forgotten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-'));
  const repo = new SqliteRepository(join(dir, 'graph.db'));
  repo.setLayout([
    { kind: 'visit', id: 'a', x: 1, y: 2 },
    { kind: 'relation', id: 'r-a-b', x: 5, y: -6 },
  ]);
  repo.setLayout([{ kind: 'visit', id: 'a', x: 3, y: 4 }]);
  assert.deepEqual(repo.layoutEntries().find((e) => e.id === 'a'), { kind: 'visit', id: 'a', x: 3, y: 4 });
  repo.setLayout([{ kind: 'visit', id: 'a' }]);
  assert.deepEqual(repo.layoutEntries().map((e) => e.id), ['r-a-b']);
});
