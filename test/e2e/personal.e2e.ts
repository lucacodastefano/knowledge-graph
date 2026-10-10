/**
 * End-to-end: the personal graph stays readable on a graph with unrelated topics (communities,
 * levels, legend, filters). Needs `npm run build:web` first. Screenshots go to $E2E_OUT.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { SqliteRepository } from '../../src/core/sqlite-repository.ts';
import { Tracker } from '../../src/core/tracker.ts';
import { buildApp } from '../../src/server/app.ts';

const out = process.env.E2E_OUT ?? join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });

// Three unrelated subjects of 60 concepts each, one concept shared by two of them, and 8 loose questions.
const dbPath = join(tmpdir(), `kg-e2e-personal-${process.pid}.db`);
const tracker = new Tracker(new SqliteRepository(dbPath));
const topics = [
  { title: 'Piante da appartamento', branches: ['Luce', 'Annaffiatura', 'Terriccio', 'Parassiti', 'Concimazione'] },
  { title: 'Architettura software', branches: ['Microservizi', 'Event sourcing', 'Osservabilità', 'Resilienza', 'Deploy'] },
  { title: 'Cucina', branches: ['Pasta fresca', 'Lievitati', 'Fermentazione', 'Cottura', 'Salse'] },
];
for (const t of topics) {
  const conv = tracker.startConversation(t.title, null);
  tracker.track(conv.id, [{ title: t.title, summary: `Panoramica: ${t.title}.`, parent: 'root' }]);
  for (const b of t.branches) {
    tracker.track(conv.id, [{ title: b, summary: `${b} in breve.`, parent: t.title }]);
    tracker.track(
      conv.id,
      Array.from({ length: 10 }, (_, i) => ({ title: `${b} ${i + 1}`, summary: `Dettaglio ${i + 1} di ${b}.`, parent: b })),
    );
  }
}
const shared = tracker.startConversation('Fermentazione e suolo', null);
tracker.track(shared.id, [
  { title: 'Fermentazione', summary: 'Anche nel compost.', parent: 'root' },
  { title: 'Terriccio', summary: 'Il compost lo arricchisce.', parent: 'Fermentazione' },
]);
const loose = tracker.startConversation('Domande sparse', null);
const looseTitles = ['Fuso orario', 'Effetto Doppler', 'Origami', 'Numeri primi', 'Vulcani', 'Yoga', 'Aurora boreale', 'Scacchi'];
// Two loose questions cite sources: the "solo concetti con fonti" filter keeps only them.
const withSources: Record<string, string[]> = {
  Vulcani: ['https://example.org/vulcani'],
  'Aurora boreale': ['https://example.org/aurora', 'https://example.org/sole'],
};
for (const title of looseTitles) {
  tracker.track(loose.id, [{ title, summary: `${title}.`, parent: 'root', sources: withSources[title] }]);
}
const total = 3 * 56 + looseTitles.length;
// The cooking conversation happened two months ago: the period filter must leave it out.
const db = new DatabaseSync(dbPath);
const old = new Date(Date.now() - 60 * 86400_000).toISOString();
db.prepare(
  `UPDATE concepts SET last_seen_at = ? WHERE id IN (
     SELECT v.concept_id FROM visits v JOIN conversations c ON c.id = v.conversation_id WHERE c.title = 'Cucina')
   AND id NOT IN (SELECT v.concept_id FROM visits v JOIN conversations c ON c.id = v.conversation_id WHERE c.title <> 'Cucina')`,
).run(old);
db.close();

const app = await buildApp({ tracker, webRoot: join(import.meta.dirname, '..', '..', 'web', 'dist') });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
after(async () => {
  await browser.close();
  await app.close();
});

interface Probe {
  position(label: string): { x: number; y: number } | null;
  bubbles(): { name: string; count: number; x: number; y: number; r: number }[];
  community(label: string): string | null;
  ratio(): number;
}
/** Runs `fn` in the page against the view's test hook (WebGL draws nothing in the DOM). */
const probe = <T>(page: Page, fn: (k: Probe) => T) => page.evaluate(`(${fn.toString()})(window.__kgPersonal)`) as Promise<T>;
const level = (page: Page) => page.getByTestId('personal-graph').getAttribute('data-level');

test('from afar the personal graph shows one named bubble per topic; closer, the concepts (levels)', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(`${base}/#personale`);
  const counter = page.getByTestId('concept-count');
  await counter.waitFor();
  assert.equal(await counter.innerText(), `${total} concetti`);
  await page.waitForTimeout(400);
  assert.equal(await level(page), 'overview');

  // Unrelated subjects end up in different communities, a branch stays with its topic.
  const [plants, software, cooking, branch] = await probe(page, (k) =>
    ['Luce 3', 'Microservizi 3', 'Pasta fresca 3', 'Luce'].map((l) => k.community(l)),
  );
  assert.notEqual(plants, software);
  assert.notEqual(plants, cooking);
  assert.notEqual(software, cooking);
  assert.equal(branch, plants);
  // Loose questions are grouped apart instead of being scattered among the topics.
  assert.equal(await probe(page, (k) => k.community('Origami')), 'isolated');

  const bubbles = await probe(page, (k) => k.bubbles());
  const names = bubbles.map((b) => b.name);
  assert.ok(names.includes('Concetti isolati'), names.join(', '));
  for (const [i, a] of bubbles.entries()) {
    for (const b of bubbles.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r, `${a.name} overlaps ${b.name}`);
  }
  const legend = page.getByRole('list', { name: 'Legenda' });
  assert.match(await legend.innerText(), /Concetti isolati\s+8/);
  await page.screenshot({ path: join(out, '20-personale-da-lontano.png') });

  // A click on a bubble zooms into it: the single concepts and their labels appear.
  const box = (await page.getByTestId('personal-graph').boundingBox())!;
  const target = bubbles.filter((b) => b.name !== 'Concetti isolati').sort((a, b) => b.count - a.count)[0];
  await page.mouse.click(box.x + target.x + target.r * 0.5, box.y + target.y);
  await page.waitForFunction(() => document.querySelector('[data-testid=personal-graph]')?.getAttribute('data-level') === 'detail');
  assert.ok((await probe(page, (k) => k.ratio())) < 1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '21-personale-da-vicino.png') });

  // The zoom buttons go back to the whole picture.
  await page.getByRole('button', { name: 'Mostra tutto' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=personal-graph]')?.getAttribute('data-level') === 'overview');
});

test('colour by community or conversation with a legend, and filters by conversation, period, isolation and sources', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(`${base}/#personale`);
  const counter = page.getByTestId('concept-count');
  await counter.waitFor();
  const legend = page.getByRole('list', { name: 'Legenda' });

  await page.getByLabel('Colora per').selectOption('conversation');
  await legend.getByText('Architettura software').waitFor();
  assert.match(await legend.innerText(), /Domande sparse\s+8/);
  await page.screenshot({ path: join(out, '22-personale-per-conversazione.png') });

  // A legend entry highlights its group; a second click shows everything again.
  const entry = legend.getByRole('button', { name: /Architettura software/ });
  await entry.click();
  assert.equal(await entry.getAttribute('aria-pressed'), 'true');
  await entry.click();
  assert.equal(await entry.getAttribute('aria-pressed'), 'false');
  await page.getByLabel('Colora per').selectOption('community');

  await page.getByLabel('Nascondi isolati').check();
  await page.getByText(`${total - looseTitles.length} di ${total} concetti`).waitFor();
  assert.equal(await probe(page, (k) => k.position('Origami')), null, 'isolated concepts are hidden');

  await page.getByLabel('Periodo').selectOption('7');
  // Cooking was two months ago; "Fermentazione" and "Terriccio" were seen again this week.
  await page.getByText(`${2 * 56 + 1} di ${total} concetti`).waitFor();
  assert.equal(await probe(page, (k) => k.position('Pasta fresca 3')), null);
  await page.screenshot({ path: join(out, '23-personale-filtri.png') });

  await page.getByLabel('Periodo').selectOption('');
  await page.getByLabel('Nascondi isolati').uncheck();

  // Only the concepts that cite at least one source.
  await page.getByLabel('Solo concetti con fonti').check();
  await page.getByText(`2 di ${total} concetti`).waitFor();
  assert.notEqual(await probe(page, (k) => k.position('Vulcani')), null);
  assert.equal(await probe(page, (k) => k.position('Origami')), null);
  await page.getByLabel('Solo concetti con fonti').uncheck();
  const value = await page.locator('select[aria-label="Filtra conversazione"] option', { hasText: 'Piante da appartamento' }).getAttribute('value');
  await page.getByLabel('Filtra conversazione').selectOption(value!);
  await page.getByText(`56 di ${total} concetti`).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await level(page), 'detail', 'one conversation fits on screen with its labels');
  await page.screenshot({ path: join(out, '24-personale-una-conversazione.png') });

  // The colouring and the isolated toggle are remembered; the filters are not.
  await page.getByLabel('Colora per').selectOption('conversation');
  await page.reload();
  await counter.waitFor();
  assert.equal(await page.getByLabel('Colora per').inputValue(), 'conversation');
  assert.equal(await page.getByLabel('Filtra conversazione').inputValue(), '');
});

test('a superclass gathers topics of different conversations into one named area (D18)', async () => {
  const find = async (q: string) => ((await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`)).json()) as { id: string; name: string }[]).find((c) => c.name === q)!.id;
  const res = await fetch(`${base}/api/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Vita domestica', conceptIds: [await find('Piante da appartamento'), await find('Cucina')] }),
  });
  assert.equal(res.status, 200);
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(`${base}/#personale`);
  await page.getByTestId('concept-count').waitFor();
  await page.waitForTimeout(500);
  const [plants, cooking, hub, software] = await probe(page, (k) => ['Piante da appartamento', 'Cucina', 'Vita domestica', 'Microservizi 3'].map((l) => k.community(l)));
  assert.match(plants ?? '', /^s:/, 'grouped concepts take the area of their superclass');
  assert.equal(plants, cooking);
  assert.equal(plants, hub, 'the superclass itself sits in its area');
  assert.notEqual(plants, software);
  assert.ok((await probe(page, (k) => k.bubbles())).some((b) => b.name === 'Vita domestica'), 'the area is named after the superclass');
  await page.screenshot({ path: join(out, '13-superclasse.png') });
  await page.close();
});
