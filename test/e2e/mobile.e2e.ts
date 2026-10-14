/**
 * End-to-end on a phone: iPhone 13 emulation (390x844, touch) against the built canvas (analisi/12-interfaccia-mobile.md).
 * Needs `npm run build:web` first. Screenshots go to $E2E_OUT (default: test/e2e/out).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { SqliteRepository } from '../../src/core/sqlite-repository.ts';
import { Tracker } from '../../src/core/tracker.ts';
import { buildApp } from '../../src/server/app.ts';

const out = process.env.E2E_OUT ?? join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });

const app = await buildApp({
  tracker: new Tracker(new SqliteRepository(join(tmpdir(), `kg-e2e-mobile-${process.pid}.db`))),
  webRoot: join(import.meta.dirname, '..', '..', 'web', 'dist'),
});
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
after(async () => {
  await browser.close();
  await app.close();
});

await new Promise<void>((resolve, reject) => {
  const p = spawn(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'simulate.ts'), base, '10']);
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`simulate exited ${code}`))));
});

const IPHONE = {
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
/** Every parent-child link of the graph is drawn as a visible, non-empty line (a missing edge layer or hidden handles lose them). */
async function assertEdgesDrawn(page: import('playwright').Page) {
  const [conv] = await (await page.request.get(`${base}/api/conversations`)).json();
  const tree = await (await page.request.get(`${base}/api/conversations/${conv.id}/tree`)).json();
  const expected = tree.visits.filter((v: { parentVisitId: string | null }) => v.parentVisitId).length;
  assert.ok(expected >= 8, 'the sample graph has parent-child links');
  await page.waitForFunction((n) => document.querySelectorAll('.react-flow__edge:not(.cross-link):not(.relation)').length >= n, expected);
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll<SVGPathElement>('.react-flow__edge:not(.cross-link):not(.relation) path.react-flow__edge-path')].filter((p) => p.getTotalLength() > 5 && getComputedStyle(p).visibility !== 'hidden').length,
  );
  assert.equal(drawn, expected, 'one visible line per parent-child link');
}

/** A node that is on screen at the initial zoom (the view opens on the current node). */
const visibleNode = (page: Page) => page.locator('[data-testid=visit]').filter({ has: page.locator('.visit-title', { hasText: 'Proiezioni di lettura' }) });
const phone = (width = 390, height = 844) => browser.newContext({ ...IPHONE, viewport: { width, height } });

/** Nothing sticks out sideways: neither the page nor any scrolling area is wider than the screen. */
const noSideScroll = (page: Page) =>
  page.evaluate(() => {
    const wide = [...document.querySelectorAll<HTMLElement>('main, main *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible' && !e.closest('.react-flow, .markdown'));
    return { page: document.documentElement.scrollWidth <= innerWidth, wide: wide.map((e) => e.className) };
  });

/** True when the element is the topmost thing at its own centre (not covered by another bar) and big enough to tap. */
const reachable = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === el || el.contains(top)) && r.width >= 40 && r.height >= 40 && r.right <= innerWidth && r.left >= 0;
  }, selector);

/** A one-finger drag as real touch events (a synthetic pointer event does not exercise the touch path). */
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p: { x: number; y: number } | null) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
  await touch('touchStart', from);
  for (let i = 1; i <= 8; i++) await touch('touchMove', { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 });
  await touch('touchEnd', null);
  await cdp.detach();
}

test('phone: header, graph bar and Approfondisci stay inside the screen and reachable', async () => {
  const ctx = await phone();
  const page = await ctx.newPage();
  await page.goto(base);
  await page.locator('[data-testid=visit]').first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'm1-grafo.png') });

  assert.deepEqual(await noSideScroll(page), { page: true, wide: [] });
  const header = (await page.locator('header.bar').boundingBox())!;
  assert.ok(header.height <= 56, `header is one row (${header.height}px)`);
  assert.equal(await page.locator('.bar-map').evaluate((e) => e.getBoundingClientRect().width > 120), true, 'graph selector has room');
  await assertEdgesDrawn(page);
  const zoom = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform).a);
  assert.ok(zoom >= 0.7, `readable initial zoom (${zoom})`);

  // ⋯ menu: opens inside the screen and does not scroll the canvas sideways.
  await page.getByRole('button', { name: 'Altre azioni' }).tap();
  const menu = (await page.locator('.overlay-bar .menu').boundingBox())!;
  assert.ok(menu.x >= 0 && menu.x + menu.width <= 390, 'menu inside the screen');
  assert.ok((await page.getByRole('menuitemradio', { name: /Layout:/ }).count()) > 0, 'view controls moved into the menu');
  await page.screenshot({ path: join(out, 'm2-menu.png') });
  await page.getByRole('button', { name: 'Altre azioni' }).tap();
  // Link picker.
  await page.getByRole('button', { name: 'Collega a un altro grafo' }).first().tap();
  await page.waitForTimeout(200);
  assert.deepEqual(await noSideScroll(page), { page: true, wide: [] });
  const picker = (await page.locator('.overlay-bar .link-picker').boundingBox())!;
  assert.ok(picker.x >= 0 && picker.x + picker.width <= 390, 'picker inside the screen');
  await page.screenshot({ path: join(out, 'm3-rimando.png') });
  await page.getByRole('button', { name: 'Collega a un altro grafo' }).first().tap();

  // Tap a node: it is selected and the action bar appears; "Approfondisci" opens the sheet.
  await visibleNode(page).tap();
  const actions = page.getByRole('toolbar', { name: 'Azioni sul nodo' });
  await actions.waitFor();
  await page.screenshot({ path: join(out, 'm4-azioni.png') });
  await actions.getByRole('button', { name: 'Approfondisci' }).tap();
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.waitFor();
  await panel.locator('.visits > li').first().waitFor();
  assert.ok(await reachable(page, '.panel [aria-label=Chiudi]'), 'close button is on top and tappable');
  assert.ok(await reachable(page, '.panel [aria-label=Modifica]'), 'edit button is on top and tappable');
  assert.equal(await page.locator('.panel .width-switch').isVisible(), false);
  await panel.evaluate((e) => e.scrollTo(0, 600));
  assert.ok(await reachable(page, '.panel [aria-label=Chiudi]'), 'header stays in reach after scrolling');
  await panel.evaluate((e) => e.scrollTo(0, 0));
  await page.screenshot({ path: join(out, 'm5-approfondisci.png') });
  await panel.getByRole('button', { name: 'Chiudi', exact: true }).tap();
  await panel.waitFor({ state: 'detached' });
  await ctx.close();
});

test('phone: a swipe that starts on a node pans the canvas instead of moving the node', async () => {
  const ctx = await phone();
  const page = await ctx.newPage();
  await page.goto(base);
  await page.locator('[data-testid=visit]').first().waitFor();
  await page.waitForTimeout(800);
  const a = visibleNode(page);
  const near = page.locator('[data-testid=visit]').filter({ has: page.locator('.visit-title', { hasText: 'Partizioni Kafka' }) });
  const [a1, n1] = [await a.boundingBox(), await near.boundingBox()];
  const from = { x: a1!.x + a1!.width / 2, y: a1!.y + a1!.height / 2 };
  await swipe(page, from, { x: from.x, y: from.y + 100 });
  await page.waitForTimeout(300);
  const [a2, n2] = [await a.boundingBox(), await near.boundingBox()];
  assert.ok(Math.abs(a2!.y - a1!.y - 100) < 8 && Math.abs(n2!.y - n1!.y - 100) < 8, 'every node moved together with the canvas');
  assert.equal(await page.locator('.toast').count(), 0, 'no node was moved');
  await ctx.close();
});

test('phone: search opens full width; Globale and Metriche do not scroll sideways', async () => {
  const ctx = await phone();
  const page = await ctx.newPage();
  await page.goto(base);
  await page.locator('[data-testid=visit]').first().waitFor();
  await page.getByRole('button', { name: 'Cerca' }).tap();
  const input = page.getByLabel('Cerca concetti', { exact: true });
  await input.fill('kafka');
  await page.getByRole('option').first().waitFor();
  assert.ok((await input.boundingBox())!.width > 250, 'search box is wide');
  assert.ok((await page.getByRole('listbox').boundingBox())!.width > 340, 'results are wide');
  assert.equal(await input.evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 16), true, 'no iOS zoom on focus');
  await page.screenshot({ path: join(out, 'm6-ricerca.png') });
  await page.getByRole('button', { name: 'Annulla' }).tap();

  await page.getByRole('tab', { name: 'Metriche' }).tap();
  await page.locator('.metrics').waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(await noSideScroll(page), { page: true, wide: [] });
  await page.screenshot({ path: join(out, 'm7-metriche.png') });

  await page.getByRole('tab', { name: 'Globale' }).tap();
  await page.locator('[data-testid=concept-count]').waitFor();
  await page.waitForTimeout(500);
  const tools = (await page.locator('.graph-tools').boundingBox())!;
  assert.ok(tools.height < 70, `toolbar folded to one row (${tools.height}px)`);
  await page.screenshot({ path: join(out, 'm8-globale.png') });
  await page.getByRole('button', { name: /Filtri/ }).tap();
  await page.screenshot({ path: join(out, 'm9-filtri.png') });
  assert.deepEqual(await noSideScroll(page), { page: true, wide: [] });
  await ctx.close();
});

test('phone landscape: the sheet header is not covered', async () => {
  const ctx = await phone(844, 390);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.locator('[data-testid=visit]').first().waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, 'm10-landscape.png') });
  await visibleNode(page).tap();
  await page.getByRole('toolbar', { name: 'Azioni sul nodo' }).getByRole('button', { name: 'Approfondisci' }).tap();
  await page.getByLabel('Dettaglio concetto').waitFor();
  assert.ok(await reachable(page, '.panel [aria-label=Chiudi]'));
  await page.screenshot({ path: join(out, 'm11-approfondisci-landscape.png') });
  await ctx.close();
});
