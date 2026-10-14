/** End-to-end: a map exported as one .html file opens from disk (file://) with no server and cannot be edited. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SqliteRepository } from '../../src/core/sqlite-repository.ts';
import { Tracker } from '../../src/core/tracker.ts';
import { buildApp } from '../../src/server/app.ts';

const tracker = new Tracker(new SqliteRepository(join(tmpdir(), `kg-export-e2e-${process.pid}.db`)));
const app = await buildApp({ tracker, webRoot: join(import.meta.dirname, '..', '..', 'web', 'dist') });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
after(async () => {
  await browser.close();
  await app.close();
});

test('an exported map opens from file:// read only, with its detail, and talks to nobody', async () => {
  const a = tracker.startConversation('Kafka in breve', null);
  const b = tracker.startConversation('Altro grafo', null);
  const [kafka] = tracker.track(a.id, [
    { title: 'Kafka', summary: 'Un log distribuito.', parent: 'root', detail: '## Idea\n\nUn **log** append-only.\n\n- partizioni\n- repliche', sources: ['https://kafka.apache.org/documentation'] },
  ]);
  const [partitions] = tracker.track(a.id, [{ title: 'Partizioni', summary: 'Parallelismo.', parent: 'Kafka', detail: 'Ogni partizione è ordinata.' }]);
  const [offset] = tracker.track(a.id, [{ title: 'Offset', summary: 'Posizione nel log.', parent: 'Kafka' }]);
  tracker.track(b.id, [{ title: 'Kafka', summary: 'TESTO-ALTRO-GRAFO', parent: 'root', detail: 'TESTO-ALTRO-GRAFO' }]);
  tracker.setRelation(partitions.conceptId, offset.conceptId, true, 'numera', a.id);
  tracker.repo.setLayout([{ kind: 'visit', id: kafka.id, x: 0, y: 0 }]);

  const res = await fetch(`${base}/api/conversations/${a.id}/export.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /filename="kafka-in-breve\.html"/);
  const file = join(tmpdir(), `kg-export-${process.pid}.html`);
  writeFileSync(file, await res.text());
  console.log(`# exported file: ${statSync(file).size} bytes`);

  // The daemon is still up, but the page must not use it: every request and socket is recorded.
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (w) => requests.push(w.url()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`file://${file}`);
  await page.locator('[data-testid=visit]').nth(2).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('[data-testid=visit]').count(), 3);
  assert.equal(await page.locator('.react-flow__edge.relation').count(), 1, 'the dashed relation is drawn');
  await page.waitForTimeout(500);

  const node = (title: string) => page.locator('[data-testid=visit]').filter({ has: page.locator('.visit-title', { hasText: new RegExp(`^${title}$`) }) });
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(300);
  await node('Kafka').dblclick();
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.getByRole('heading', { name: 'Idea' }).waitFor();
  assert.match(await panel.locator('strong').first().innerText(), /log/);
  assert.equal(await panel.locator('li', { hasText: 'repliche' }).count() > 0, true, 'markdown list rendered');
  await panel.getByRole('heading', { name: 'Partizioni' }).waitFor();
  assert.equal(await panel.getByRole('link', { name: 'kafka.apache.org/documentation' }).count(), 1, 'sources');
  assert.doesNotMatch(await panel.innerText(), /TESTO-ALTRO-GRAFO|Anche in altri grafi/);

  // Read only: no editing, menu, tabs or map list.
  for (const name of ['Modifica', 'Altre azioni', 'Riordina', 'Layout']) assert.equal(await page.getByLabel(name, { exact: true }).count(), 0, name);
  assert.equal(await page.getByRole('tab').count(), 0, 'no tabs');
  assert.equal(await page.getByRole('combobox').count(), 0, 'no map list');
  await panel.getByRole('button', { name: 'Chiudi', exact: true }).click();

  // A node cannot be dragged: dragging it pans the canvas at most, so it keeps its place relative to the others.
  const gap = async () => {
    const [o, k] = await Promise.all([node('Offset').boundingBox(), node('Kafka').boundingBox()]);
    return { x: o!.x - k!.x, y: o!.y - k!.y };
  };
  const before = await gap();
  const box = (await node('Offset').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  const moved = await gap();
  assert.ok(Math.abs(moved.x - before.x) < 2 && Math.abs(moved.y - before.y) < 2, 'node did not move');

  // Search inside the map.
  await page.getByLabel('Cerca concetti').fill('ordinata');
  await page.getByRole('option', { name: /Partizioni/ }).first().click();
  await panel.getByRole('heading', { name: 'Partizioni' }).first().waitFor();

  assert.deepEqual(requests.filter((u) => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')), [], 'no network requests');
  assert.deepEqual(errors, []);
  await page.close();
});

test('an exported map keeps the folded branches and their toggles', async () => {
  const a = tracker.startConversation('Rami piegati', null);
  const [root] = tracker.track(a.id, [{ title: 'Radice', summary: 'r', parent: 'root' }]);
  tracker.track(a.id, [
    { title: 'Uno', summary: 'u', parent: 'Radice' },
    { title: 'Due', summary: 'd', parent: 'Radice' },
  ]);
  tracker.repo.setLayout([{ kind: 'collapsed', id: root.id, x: 0, y: 0 }]);
  const file = join(tmpdir(), `kg-export-fold-${process.pid}.html`);
  writeFileSync(file, await (await fetch(`${base}/api/conversations/${a.id}/export.html`)).text());
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(`file://${file}`);
  const toggle = page.getByTestId('collapse-toggle');
  await toggle.waitFor();
  assert.equal(await page.locator('[data-testid=visit]').count(), 1);
  assert.equal((await toggle.innerText()).trim(), '2');
  await toggle.click();
  await page.locator('[data-testid=visit]').nth(2).waitFor();
  assert.equal((await toggle.innerText()).trim(), '−');
  await page.close();
});
