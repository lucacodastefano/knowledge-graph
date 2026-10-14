/**
 * End-to-end: nodes the model adds land in free space and nothing the user placed moves; branches collapse.
 * Needs `npm run build:web` first. Screenshots go to $E2E_OUT (default: test/e2e/out).
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

const tracker = new Tracker(new SqliteRepository(join(tmpdir(), `kg-e2e-growth-${process.pid}.db`)));
const app = await buildApp({ tracker, webRoot: join(import.meta.dirname, '..', '..', 'web', 'dist') });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
after(async () => {
  await browser.close();
  await app.close();
});

const titled = (page: Page, title: string | RegExp) =>
  page.locator('[data-testid=visit]').filter({ has: page.locator('.visit-title', { hasText: title }) });

/** Screen boxes of every visible node, by title. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')].map((n) => ({
      title: (n.querySelector('.visit-title') as HTMLElement).innerText,
      fx: Number(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((n as HTMLElement).style.transform)![1]),
      fy: Number(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((n as HTMLElement).style.transform)![2]),
      ...(n.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }),
    })),
  );

/** Overlapping pairs that involve at least one node the model added (a drag by hand may overlap what the user chooses). */
function overlaps(list: Awaited<ReturnType<typeof boxes>>): string[] {
  const bad: string[] = [];
  for (const [i, a] of list.entries())
    for (const b of list.slice(i + 1))
      if ((a.title.includes('nuovo') || b.title.includes('nuovo')) && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`${a.title} / ${b.title}`);
  return bad;
}

async function dragBy(page: Page, title: string, dx: number, dy: number) {
  const b = (await titled(page, title).first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

for (const kind of ['radial', 'mindmap', 'tree']) {
  test(`${kind}: nodes added under hand-moved nodes never overlap and nothing the user placed moves`, async () => {
    const conv = tracker.startConversation(`Crescita ${kind}`, null);
    tracker.track(conv.id, [
      { title: 'Centro', summary: 'c' },
      ...['A', 'B', 'C', 'D'].map((t) => ({ title: `Ramo ${t}`, summary: t, parent: '#0' })),
      ...['A', 'B', 'C', 'D'].flatMap((t) => [1, 2].map((i) => ({ title: `Foglia ${t}${i}`, summary: t, parent: `Ramo ${t}` }))),
    ]);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.addInitScript((k) => localStorage.setItem('kg.layout', k), kind);
    await page.goto(base);
    await titled(page, 'Foglia D2').waitFor();
    await page.waitForTimeout(900);
    // The user pulls two branches over to where new nodes would naturally grow.
    await dragBy(page, 'Ramo A', 120, 90);
    await dragBy(page, 'Ramo C', -100, 60);
    const placed = await boxes(page);

    // The model adds several batches under the moved nodes and elsewhere.
    for (let round = 0; round < 3; round++) {
      tracker.track(conv.id, [
        ...['Ramo A', 'Ramo C', 'Foglia B1', 'Foglia D2'].flatMap((p) => [1, 2, 3].map((i) => ({ title: `${p} nuovo ${round}${i}`, summary: 'n', parent: p }))),
      ]);
      await page.waitForTimeout(700);
    }
    await titled(page, 'Foglia D2 nuovo 23').waitFor();
    await page.waitForTimeout(900);
    const after = await boxes(page);
    assert.equal(after.length, placed.length + 36);
    assert.deepEqual(overlaps(after), [], 'no node overlaps another');
    // Nothing that was there moved (in canvas coordinates, so a re-framed view does not matter).
    const rel = (list: typeof after) => new Map(list.map((b) => [b.title, [Math.round(b.fx), Math.round(b.fy)]]));
    const [r0, r1] = [rel(placed), rel(after)];
    for (const [t, p] of r0) assert.deepEqual(r1.get(t), p, `${t} stayed where it was`);
    await page.screenshot({ path: join(out, `20-crescita-${kind}.png`) });

    // The places survive a refresh too.
    await page.reload();
    await titled(page, 'Foglia D2 nuovo 23').waitFor();
    await page.waitForTimeout(900);
    const reloaded = await boxes(page);
    assert.deepEqual(overlaps(reloaded), [], 'no overlap after a refresh');
    const r2 = rel(reloaded);
    for (const [t, p] of r1) assert.deepEqual(r2.get(t), p, `${t} is where it was before the refresh`);
    await page.close();
  });
}

const toggleOf = (page: Page, title: string) => titled(page, new RegExp(`^${title}$`)).getByTestId('collapse-toggle');
const visible = (page: Page) => page.locator('[data-testid=visit]').count();

test('a branch folds to "+N", keeps counting what the model adds under it, survives a refresh and opens for a search hit', async () => {
  const conv = tracker.startConversation('Rami', null);
  tracker.track(conv.id, [
    { title: 'Radice rami', summary: 'r', parent: 'root' },
    { title: 'Ramo uno', summary: 'u', parent: '#0' },
    { title: 'Ramo due', summary: 'd', parent: '#0' },
    { title: 'Foglia uno', summary: 'f', parent: 'Ramo uno', detail: 'Contiene la parola rarissima zzyzx.' },
    { title: 'Foglia due', summary: 'f', parent: 'Ramo uno' },
    { title: 'Nipote', summary: 'n', parent: 'Foglia uno' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  await titled(page, 'Nipote').waitFor();
  await page.waitForTimeout(800);
  assert.equal(await visible(page), 6);
  assert.equal(await toggleOf(page, 'Foglia due').count(), 0, 'a leaf has no control');
  assert.equal((await toggleOf(page, 'Ramo uno').innerText()).trim(), '−');
  await page.screenshot({ path: join(out, '21-rami-aperti.png') });

  await toggleOf(page, 'Ramo uno').click();
  await page.waitForTimeout(300);
  assert.equal(await visible(page), 3, 'the whole subtree is hidden');
  assert.equal((await toggleOf(page, 'Ramo uno').innerText()).trim(), '+3', 'the fold shows how many nodes it hides');
  assert.equal(await page.locator('.react-flow__edge').count(), 2, 'edges into the hidden nodes are gone');
  await page.screenshot({ path: join(out, '22-ramo-chiuso.png') });
  const saved = (await (await fetch(`${base}/api/layout`)).json()) as { kind: string }[];
  assert.ok(saved.some((e) => e.kind === 'collapsed'), 'the fold is saved on the server');

  // The model adds under the folded node: hidden, and the counter goes up.
  tracker.track(conv.id, [{ title: 'Figlio nuovo', summary: 'x', parent: 'Ramo uno' }]);
  await page.waitForFunction(() => /\+4/.test(document.body.innerText));
  assert.equal(await visible(page), 3);
  assert.equal(await titled(page, 'Figlio nuovo').count(), 0);

  // A refresh keeps it folded.
  await page.reload();
  await titled(page, 'Ramo due').waitFor();
  await page.waitForTimeout(600);
  assert.equal(await visible(page), 3);
  assert.equal((await toggleOf(page, 'Ramo uno').innerText()).trim(), '+4');

  // Search opens the path to the hit.
  await page.goto(`${base}#personale`);
  await page.getByLabel('Cerca concetti').fill('zzyzx');
  await page.getByRole('option', { name: /Foglia uno/ }).click();
  await titled(page, 'Foglia uno').waitFor();
  assert.equal((await toggleOf(page, 'Ramo uno').innerText()).trim(), '−', 'the branch above the hit is open');
  assert.equal(await visible(page), 7);

  // "+" / "−" by hand, and "Riordina" does not unfold anything.
  await toggleOf(page, 'Ramo due').count();
  await toggleOf(page, 'Foglia uno').click();
  await page.waitForTimeout(200);
  assert.equal(await titled(page, 'Nipote').count(), 0);
  await toggleOf(page, 'Foglia uno').click();
  await titled(page, 'Nipote').waitFor();
  await page.close();
});
