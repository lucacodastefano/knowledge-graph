import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairMarkdown } from '../src/core/markdown-repair.ts';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';

const glued = 'Regola. | Esito | Righe | |---|---| | Funzionale | J06 | | Di progetto | M01 |';
const fixed = 'Regola.\n\n| Esito | Righe |\n|---|---|\n| Funzionale | J06 |\n| Di progetto | M01 |';

test('a table glued onto one line gets its rows back; repairing twice changes nothing', () => {
  assert.equal(repairMarkdown(glued), fixed);
  assert.equal(repairMarkdown(fixed), fixed);
});

test('glued lists are split; prose, code blocks and proper tables are left alone', () => {
  assert.equal(repairMarkdown('Passi: 1. Installa 2. Configura 3. Avvia'), 'Passi:\n1. Installa\n2. Configura\n3. Avvia');
  assert.equal(repairMarkdown('Tipi: - A - B - C'), 'Tipi:\n- A\n- B\n- C');
  for (const same of ['Kafka - broker - topic', '| a | b |\n|---|---|\n| 1 | 2 |', '```\n| a | b | |---|---| | 1 | 2 |\n```', 'Versione 1. Poi 3. cosa']) {
    assert.equal(repairMarkdown(same), same);
  }
});

test('the tracker repairs details on write and an existing database once on open', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kg-')), 'g.db');
  const t = new Tracker(new SqliteRepository(file));
  const c = t.startConversation('G', null);
  const [n] = t.track(c.id, [{ title: 'N', summary: 's', parent: 'root', detail: glued }]);
  assert.equal(t.repo.getVisit(n.id)!.detail, fixed);
  t.editNode(c.id, n.id, { append: 'Fine: 1. a 2. b' });
  assert.match(t.repo.getVisit(n.id)!.detail!, /\n1\. a\n2\. b$/);

  t.repo.setSetting('migrated_markdown_repair', '');
  (t.repo as unknown as { db: { prepare(sql: string): { run(...a: string[]): void } } }).db.prepare('UPDATE visits SET detail = ? WHERE id = ?').run(glued, n.id);
  assert.equal(new SqliteRepository(file).getVisit(n.id)!.detail, fixed);
});
