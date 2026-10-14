/**
 * End-to-end: reference nodes between graphs (D25). Needs `npm run build:web` first. Screenshots go to $E2E_OUT.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { SqliteRepository } from '../../src/core/sqlite-repository.ts';
import { Tracker } from '../../src/core/tracker.ts';
import { buildApp } from '../../src/server/app.ts';

const out = process.env.E2E_OUT ?? join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });

const tracker = new Tracker(new SqliteRepository(join(tmpdir(), `kg-e2e-ref-${process.pid}.db`)));
const app = await buildApp({ tracker, webRoot: join(import.meta.dirname, '..', '..', 'web', 'dist') });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
after(async () => {
  await browser.close();
  await app.close();
});

const titled = (page: Page, title: string | RegExp) => page.locator('[data-testid=visit]').filter({ has: page.locator('.visit-title', { hasText: title }) });

test('link two graphs from the canvas, follow the reference, come back, delete one end', async () => {
  const kafka = tracker.startConversation('Kafka', null);
  const stream = tracker.startConversation('Streaming', null);
  tracker.track(stream.id, [
    { title: 'Flink', summary: 'Motore di stream processing.', parent: 'root' },
    { title: 'Finestre', summary: 'Aggregazioni nel tempo.', parent: 'Flink' },
  ]);
  tracker.track(kafka.id, [
    { title: 'Broker', summary: 'Il server che conserva i log.', parent: 'root' },
    { title: 'Topic', summary: 'Flusso con nome.', parent: 'Broker' },
    { title: 'Partizioni', summary: 'Suddivisione di un topic.', parent: 'Broker' },
  ]);

  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  await page.locator('select.bar-map').selectOption(kafka.id);
  await titled(page, 'Broker').waitFor();

  // Select Broker, then link: the reference hangs under it.
  await titled(page, 'Broker').click();
  await page.getByRole('button', { name: 'Collega a un altro grafo' }).click();
  await page.getByPlaceholder('Cerca un grafo per titolo…').fill('stream');
  await page.screenshot({ path: join(out, 'rimandi-1-scelta.png') });
  await page.getByRole('menuitem', { name: 'Streaming' }).click();
  const ref = titled(page, '↗ Streaming');
  await ref.waitFor();
  assert.match((await ref.getAttribute('class')) ?? '', /\bref\b/);
  await page.mouse.click(700, 760);
  await page.waitForTimeout(1900); // the new node's glow
  await page.screenshot({ path: join(out, 'rimandi-2-grafo-partenza.png') });

  // The return node exists in the other graph, hanging under its main node (Flink).
  const back = tracker.repo.getTree(stream.id)!.visits.find((v) => v.ref);
  assert.equal(back?.title, 'Kafka');
  assert.equal(back?.parentVisitId, tracker.repo.getTree(stream.id)!.visits.find((v) => v.title === 'Flink')!.id);

  // Click on the reference: Streaming opens centred on the return node, with "← torna a Kafka".
  await ref.click();
  await titled(page, '↗ Kafka').waitFor();
  await page.getByRole('button', { name: /torna a Kafka/ }).waitFor();
  assert.equal(await page.locator('select.bar-map').inputValue(), stream.id);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, 'rimandi-3-grafo-arrivo.png') });

  // The return node leads back too; "torna a" works as well and restores the history.
  await page.getByRole('button', { name: /torna a Kafka/ }).click();
  await titled(page, 'Broker').waitFor();
  assert.equal(await page.locator('select.bar-map').inputValue(), kafka.id);
  assert.equal(await page.getByRole('button', { name: /torna a/ }).count(), 0);

  // Deleting one end removes both: select the reference and press Delete.
  await titled(page, '↗ Streaming').waitFor();
  await page.mouse.click(700, 760);
  await titled(page, '↗ Streaming').hover();
  // A click follows the reference, so select it through the other graph's return node instead and delete that.
  await titled(page, '↗ Streaming').click();
  await titled(page, '↗ Kafka').waitFor();
  await page.waitForTimeout(800); // the arrival selects the return node once the view has moved
  await page.keyboard.press('Delete');
  await titled(page, '↗ Kafka').waitFor({ state: 'detached' });
  assert.equal(tracker.repo.getTree(kafka.id)!.visits.some((v) => v.ref), false, 'the node in Kafka went too');
  await page.close();
});
