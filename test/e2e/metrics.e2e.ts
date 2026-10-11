/** End-to-end: the Metriche panel shows cost-vs-size charts, tool bars and quality for logged calls. Needs `npm run build:web`. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SqliteRepository } from '../../src/core/sqlite-repository.ts';
import { Tracker } from '../../src/core/tracker.ts';
import { buildApp } from '../../src/server/app.ts';

const out = process.env.E2E_OUT ?? join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });

const tracker = new Tracker(new SqliteRepository(':memory:'));
const conv = tracker.startConversation('Kafka', null);
tracker.track(conv.id, [
  { title: 'Kafka', summary: 'Log distribuito.', detail: 'Testo **completo**.', parent: 'root' },
  { title: 'Consumer group', summary: 'Consumo in parallelo.', parent: 'Kafka' },
  { title: 'Consumer groups', summary: 'Quasi lo stesso.', parent: 'Kafka' },
]);
const hours = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const sample = [
  ['kc_start', 3, 120, 900, 5, null],
  ['kc_track', 3, 2400, 1500, 12, null],
  ['kc_track', 2, 3100, 1200, 14, null],
  ['kc_track', 1, 1800, 900, 9, null],
  ['kc_recall', 0, 40, 600, 3, true],
  ['kc_read', 0, 30, 0, 2, false],
] as const;
for (const [tool, h, argChars, resultChars, durationMs, hit] of sample) {
  tracker.repo.recordToolCall({
    at: hours(h), tool, conversationId: conv.id, argChars, resultChars, durationMs,
    ok: hit !== false, error: hit === false ? 'not found' : null, nodesCreated: tool === 'kc_track' ? 1 : 0, nodesChanged: 0, hit,
  });
}

const app = await buildApp({ tracker, webRoot: join(import.meta.dirname, '../../web/dist') });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
after(async () => {
  await browser.close();
  await app.close();
});

test('the Metriche tab shows the charts and updates with the filters', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
  await page.goto(`${base}/#metriche`);
  await page.getByTestId('metrics').waitFor();
  await page.getByTestId('chart-cost-size').locator('polyline').waitFor();
  assert.ok((await page.getByTestId('chart-pernode-size').locator('circle').count()) >= 1);
  assert.equal(await page.getByText('Crescita del grafo').count(), 0);
  assert.match((await page.getByTestId('quality').textContent()) ?? '', /profondità massima/);
  const sun = page.getByTestId('chart-depth');
  assert.ok((await sun.locator('path.arc').count()) >= 1, 'sunburst arcs');
  await sun.locator('path.arc').first().dispatchEvent('mouseover');
  assert.match((await sun.locator('.sun-sub').textContent()) ?? '', /sotto/);
  assert.match((await page.getByTestId('chart-tools').textContent()) ?? '', /kc_track/);
  assert.match((await page.getByTestId('table-errors').textContent()) ?? '', /kc_read/);
  assert.match((await page.getByTestId('memory').textContent()) ?? '', /1\/1/);
  const quality = (await page.getByTestId('quality').textContent()) ?? '';
  assert.match(quality, /Consumer group ≈ Consumer groups/);
  assert.match((await page.getByTestId('metrics').textContent()) ?? '', /soltanto|solo il traffico/);
  await page.screenshot({ path: join(out, 'metriche.png'), fullPage: true });

  await page.getByLabel('Periodo').selectOption('24h');
  await page.getByLabel('Grafo', { exact: true }).selectOption(conv.id);
  await page.getByTestId('chart-cost-size').waitFor();
  await page.close();
});
