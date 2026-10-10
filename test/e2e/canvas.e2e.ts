/**
 * End-to-end: real daemon + built canvas in headless Chromium + simulated model.
 * Needs `npm run build:web` first. Screenshots go to $E2E_OUT (default: test/e2e/out).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteRepository } from '../../src/core/sqlite-repository.ts';
import { Tracker } from '../../src/core/tracker.ts';
import { buildApp } from '../../src/server/app.ts';

const out = process.env.E2E_OUT ?? join(import.meta.dirname, 'out');
mkdirSync(out, { recursive: true });

const app = await buildApp({
  tracker: new Tracker(new SqliteRepository(join(tmpdir(), `kg-e2e-${process.pid}.db`))),
  webRoot: join(import.meta.dirname, '..', '..', 'web', 'dist'),
});
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
after(async () => {
  await browser.close();
  await app.close();
});

/** A node by its title only: the "anche in" badge is part of the node's text. */
const titled = (page: import('playwright').Page, title: string | RegExp) =>
  page.locator('[data-testid=visit]').filter({ has: page.locator('.visit-title', { hasText: title }) });

function simulate(delayMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'simulate.ts'), base, String(delayMs)]);
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`simulate exited ${code}`))));
  });
}

test('the canvas starts blank and grows live while the model tracks concepts', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  await page.getByText('Il canvas è vuoto.').waitFor();
  await page.screenshot({ path: join(out, '1-vuoto.png') });

  const sim = simulate(250);
  await page.locator('[data-testid=visit]').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, '2-in-crescita.png') });
  const result = await sim;
  assert.match(result, /merged=true/);

  await page.waitForTimeout(800);
  assert.equal(await page.locator('[data-testid=visit]').count(), 12);
  assert.ok((await page.locator('.react-flow__edge.cross-link').count()) >= 2, 'dashed cross-links for returning concepts');
  await page.screenshot({ path: join(out, '3-completo.png') });

  // The radial layout spreads wider than the screen: fit the whole tree before hovering.
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(300);
  const node = titled(page, 'Consumer group');
  await node.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /ogni partizione è letta da un solo membro/);
  await page.screenshot({ path: join(out, '4-hover.png') });

  // WP6: entering another node closes the open tooltip at once; the new one opens after a short dwell.
  await titled(page, /^Partizioni$/).first().hover();
  assert.equal(await page.getByRole('tooltip').count(), 0, 'the previous tooltip closes at once');
  await page.getByRole('tooltip').waitFor();
  assert.equal(await page.getByRole('tooltip').count(), 1, 'only one tooltip at a time');
  await page.getByRole('tooltip').getByRole('button', { name: 'Approfondisci' }).click();
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.waitFor();
  // The panel opens before its data arrives: wait for the list, not just the frame.
  await panel.locator('.visits > li').nth(2).waitFor();
  assert.equal(await panel.locator('.visits > li').count(), 3, 'all visits of the concept, incl. the merged one');
  // D17: sub-concepts as sections; D16: each occurrence says where it sits, and the node shows "anche in".
  await panel.getByRole('heading', { name: 'Chiave di partizionamento' }).waitFor();
  assert.match(await panel.innerText(), /sotto «Event sourcing»/);
  assert.match(await titled(page, /^Partizioni$/).first().innerText(), /anche in:/);
  // Sources cited by the model, normalized (no tracking parameters or fragment).
  assert.equal(await panel.getByRole('region', { name: 'Fonti' }).getByRole('link', { name: 'kafka.apache.org/documentation' }).count(), 1);
  await page.screenshot({ path: join(out, '5-approfondisci.png') });
});

test('the personal graph shows every concept, previews it on hover and grows live', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(`${base}/#personale`);
  const counter = page.getByTestId('concept-count');
  await counter.waitFor();
  // 12 visits in the simulated conversation: two return to "Partizioni" and one was merged into it.
  assert.equal(await counter.innerText(), '10 concetti');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '6-grafo-personale.png') });

  const box = (await page.getByTestId('personal-graph').boundingBox())!;
  const pos = await page.evaluate(
    () => (window as unknown as { __kgPersonal: { position(l: string): { x: number; y: number } } }).__kgPersonal.position('Partizioni'),
  );
  await page.mouse.move(box.x + pos.x, box.y + pos.y);
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /Visto 3 volte/);
  await page.screenshot({ path: join(out, '7-grafo-hover.png') });
  await tooltip.getByRole('button', { name: 'Approfondisci' }).click();
  await page.getByLabel('Dettaglio concetto').locator('.visits li').nth(2).waitFor();

  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Schema registry', summary: 'Contratti degli eventi.', parent: 'root' }] } });
  await page.getByText('11 concetti').waitFor();
  await client.close();
});

test('search finds a concept and the canvas corrects nodes and concepts (RF17, D8)', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  const tree = async () => {
    const convs = (await (await fetch(`${base}/api/conversations`)).json()) as { id: string; title: string }[];
    const id = convs.find((c) => c.title.startsWith('Kafka e architetture'))!.id;
    return (await (await fetch(`${base}/api/conversations/${id}/tree`)).json()) as {
      visits: { id: string; title: string; summary: string; parentVisitId: string | null }[];
    };
  };
  await page.goto(base);
  const value = await page.locator('select[aria-label=Conversazione] option', { hasText: 'Kafka e architetture' }).getAttribute('value');
  await page.selectOption('select[aria-label=Conversazione]', value!);
  const visits = page.locator('[data-testid=visit]');
  await visits.nth(11).waitFor();

  // Search: a fragment of the name is enough; picking opens the concept and highlights its nodes.
  await page.getByLabel('Cerca concetti').fill('consu');
  await page.getByRole('option', { name: /Consumer group/ }).click();
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.getByRole('heading', { name: 'Consumer group' }).waitFor();
  await page.locator('.visit.match', { hasText: 'Consumer group' }).waitFor();
  await page.screenshot({ path: join(out, '8-ricerca.png') });

  // The pencil makes the panel editable in place: rename the concept, its node in the tree follows.
  const pencil = () => panel.getByRole('button', { name: 'Modifica', exact: true }).click();
  await pencil();
  await panel.getByLabel('Nome del concetto').fill('Consumer groups');
  await panel.getByRole('button', { name: 'Salva' }).click();
  await titled(page, /^Consumer groups$/).waitFor();

  // A name already taken is refused with a hint to merge.
  await pencil();
  await panel.getByLabel('Nome del concetto').fill('offset');
  await panel.getByRole('button', { name: 'Salva' }).click();
  assert.match(await panel.getByRole('alert').innerText(), /Esiste già «Offset»/);
  await panel.getByRole('button', { name: 'Annulla' }).click();

  // Merge a concept into another from the panel menu.
  await page.getByLabel('Cerca concetti').fill('rebal');
  await page.getByRole('option', { name: /Rebalancing/ }).click();
  await panel.getByRole('heading', { name: 'Rebalancing' }).waitFor();
  await panel.getByRole('button', { name: 'Altre azioni' }).click();
  await panel.getByRole('menuitem', { name: 'Unisci a…' }).click();
  await panel.getByLabel('Unisci a', { exact: true }).fill('consumer');
  await panel.getByRole('option', { name: /Consumer groups/ }).click();
  await panel.getByRole('heading', { name: 'Consumer groups' }).waitFor();
  await panel.locator('.visits > li').nth(1).waitFor();
  await panel.getByRole('button', { name: 'Chiudi', exact: true }).click();

  // Edit a node from its "Approfondisci": move it, rename it and edit its summary, in one save.
  const open = async (title: string) => {
    await page.locator('.react-flow__controls-fitview').click();
    await page.waitForTimeout(300);
    await titled(page, title).hover();
    await page.getByRole('tooltip').getByRole('button', { name: 'Approfondisci' }).click();
    await panel.getByRole('heading', { name: title }).waitFor();
    await pencil();
  };
  await open('Snapshot dello stato');
  const kafkaId = (await tree()).visits.find((v) => v.title === 'Apache Kafka')!.id;
  await panel.getByLabel('Sotto').selectOption(kafkaId);
  await panel.getByLabel('Nome del concetto').fill('Snapshot');
  await panel.getByLabel('Testo dalla risposta').first().fill('Fotografia periodica dello stato.');
  await page.screenshot({ path: join(out, '9a-modifica-sul-posto.png') });
  await panel.getByRole('button', { name: 'Salva' }).click();
  await titled(page, /^Snapshot$/).waitFor();
  const snap = (await tree()).visits.find((v) => v.title === 'Snapshot')!;
  assert.equal(snap.parentVisitId, kafkaId);
  assert.equal(snap.summary, 'Fotografia periodica dello stato.');
  await page.screenshot({ path: join(out, '9-modifica-nodo.png') });
  await panel.getByRole('button', { name: 'Chiudi', exact: true }).click();

  await open('Proiezioni di lettura');
  await panel.getByRole('button', { name: /Elimina questo nodo/ }).click();
  await panel.getByRole('button', { name: 'Conferma eliminazione' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=visit]').length === 11);
  await page.keyboard.press('Escape');

  // Delete a whole concept from the personal graph.
  await page.goto(`${base}/#personale`);
  await page.getByTestId('concept-count').waitFor();
  await page.getByLabel('Cerca concetti').fill('Schema reg');
  await page.getByRole('option', { name: /Schema registry/ }).click();
  await panel.getByRole('button', { name: 'Altre azioni' }).click();
  await panel.getByRole('menuitem', { name: 'Elimina concetto' }).click();
  await panel.getByRole('button', { name: 'Conferma eliminazione' }).click();
  await panel.waitFor({ state: 'detached' });
  // 11 concepts - Rebalancing (merged) - Proiezioni (deleted node) - Schema registry.
  await page.getByText('8 concetti').waitFor();
  await page.screenshot({ path: join(out, '10-grafo-corretto.png') });
});

test('three layouts, radial by default, no overlapping nodes, and the choice is remembered (WP7)', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  const value = await page.locator('select[aria-label=Conversazione] option', { hasText: 'Kafka e architetture' }).getAttribute('value');
  await page.selectOption('select[aria-label=Conversazione]', value!);
  const select = page.getByLabel('Layout');
  assert.equal(await select.inputValue(), 'radial');
  const visits = page.locator('[data-testid=visit]');
  await visits.nth(10).waitFor();
  for (const kind of ['radial', 'mindmap', 'tree']) {
    await select.selectOption(kind);
    await page.waitForTimeout(800);
    const boxes = await visits.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const overlap = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        assert.ok(!overlap, `${kind}: nodes overlap`);
      }
    }
    await page.screenshot({ path: join(out, `11-layout-${kind}.png`) });
  }
  await select.selectOption('mindmap');
  await page.reload();
  assert.equal(await page.getByLabel('Layout').inputValue(), 'mindmap');
});

/** Tree edges that do not leave their parent on the side facing the child, or do not reach the child's facing side. */
function misattached(page: import('playwright').Page, kind: string) {
  return page.evaluate((kind) => {
    const bad: string[] = [];
    const box = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`)!.getBoundingClientRect();
    for (const g of document.querySelectorAll('[data-testid^="rf__edge-t-"]')) {
      const child = g.getAttribute('data-testid')!.slice('rf__edge-t-'.length);
      const path = g.querySelector<SVGPathElement>('path.react-flow__edge-path')!;
      const m = path.getScreenCTM()!;
      const s = path.getPointAtLength(0).matrixTransform(m);
      const e = path.getPointAtLength(path.getTotalLength()).matrixTransform(m);
      const parent = /^Edge from (\S+) to /.exec(g.getAttribute('aria-label') ?? '')![1];
      const [p, c] = [box(parent), box(child)];
      const near = (a: number, b: number) => Math.abs(a - b) < 8;
      const title = (document.querySelector(`.react-flow__node[data-id="${child}"] .visit-title`) as HTMLElement).innerText;
      if (kind === 'radial') {
        if (!near(s.x, p.x + p.width / 2) || !near(s.y, p.y + p.height / 2)) bad.push(`${title}: not from the parent centre`);
        continue;
      }
      const toRight = c.x + c.width / 2 > p.x + p.width / 2;
      if (!near(s.x, toRight ? p.right : p.left) || s.y < p.top || s.y > p.bottom) bad.push(`${title}: leaves the wrong side of its parent`);
      if (!near(e.x, toRight ? c.left : c.right) || e.y < c.top || e.y > c.bottom) bad.push(`${title}: reaches the wrong side`);
    }
    return bad;
  }, kind);
}

test('mind map: balanced halves, edges on the facing side as branches move, and the hovered node highlights its relatives', async (t) => {
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  // An open MCP connection keeps the runner alive: close it even when an assertion fails.
  t.after(() => client.close());
  const track = (nodes: { title: string; parent: string }[]) =>
    client.callTool({ name: 'kc_track', arguments: { nodes: nodes.map((n) => ({ ...n, summary: `${n.title}.` })) } });
  await client.callTool({ name: 'kc_start', arguments: { title: 'Mappa mentale di prova' } });
  await track([{ title: 'Centro', parent: 'root' }]);
  await track([
    { title: 'Ramo A', parent: 'Centro' },
    { title: 'Foglia A1', parent: '#0' },
    { title: 'Ramo B', parent: 'Centro' },
    { title: 'Concetto condiviso', parent: '#2' },
    { title: 'Ramo C', parent: 'Centro' },
    { title: 'Foglia C1', parent: '#4' },
    { title: 'Ramo D', parent: 'Centro' },
    { title: 'Foglia D1', parent: '#6' },
  ]);
  await track([{ title: 'Concetto condiviso', parent: 'Ramo D' }]);

  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  const visits = page.locator('[data-testid=visit]');
  await visits.nth(9).waitFor();
  await page.getByLabel('Layout').selectOption('mindmap');
  await page.waitForTimeout(800);
  const centreX = async (title: string) => {
    const b = (await titled(page, new RegExp(`^${title}$`)).first().boundingBox())!;
    return b.x + b.width / 2;
  };
  const hub = await centreX('Centro');
  // Leaves 1, 1, 1, 2: three branches on the right, the heavier one alone on the left.
  assert.ok((await centreX('Ramo B')) > hub, 'Ramo B starts on the right');
  assert.ok((await centreX('Ramo D')) < hub, 'Ramo D starts on the left');
  assert.deepEqual(await misattached(page, 'mindmap'), []);

  // Ramo A grows to 4 leaves: the halves rebalance, B moves to the left and its edges must follow (no stale handles).
  await track([1, 2, 3].map((i) => ({ title: `Foglia A${i + 1}`, parent: 'Ramo A' })));
  await titled(page, 'Foglia A4').waitFor();
  await page.waitForTimeout(800);
  assert.ok((await centreX('Ramo B')) < (await centreX('Centro')), 'Ramo B moved to the left');
  assert.deepEqual(await misattached(page, 'mindmap'), []);
  await page.screenshot({ path: join(out, '12-mappa-mentale.png') });

  // Switching layout without reloading re-attaches every edge too.
  for (const kind of ['radial', 'tree', 'mindmap']) {
    await page.getByLabel('Layout').selectOption(kind);
    await page.waitForTimeout(800);
    assert.deepEqual(await misattached(page, kind), [], kind);
  }

  // Hover: the node, its parent and the other node of its concept stand out, with their edges; the rest fades.
  await titled(page, 'Concetto condiviso').first().hover();
  await page.locator('.visit.focus').waitFor();
  const titles = (sel: string) => page.locator(`${sel} .visit-title`).allInnerTexts();
  assert.deepEqual((await titles('.visit.related')).sort(), ['Concetto condiviso', 'Ramo B']);
  assert.equal(await page.locator('.visit.dim').count(), (await visits.count()) - 3);
  assert.equal(await page.locator('.react-flow__edge.cross-link.related').count(), 1);
  assert.equal(await page.locator('.react-flow__edge.related:not(.cross-link)').count(), 1);
  await page.screenshot({ path: join(out, '13-evidenzia.png') });
  await page.mouse.move(700, 790);
  await page.waitForFunction(() => !document.querySelector('.visit.dim'));

  // Click: the highlight stays without the pointer; a click on the canvas or Esc clears it.
  await titled(page, 'Ramo A').click();
  await page.mouse.move(700, 790);
  await page.waitForTimeout(400);
  assert.deepEqual(await titles('.visit.focus'), ['Ramo A']);
  assert.deepEqual((await titles('.visit.related')).sort(), ['Centro', 'Foglia A1', 'Foglia A2', 'Foglia A3', 'Foglia A4']);
  await page.mouse.click(700, 790);
  await page.waitForFunction(() => !document.querySelector('.visit.dim'));
  await titled(page, 'Ramo A').click();
  await page.mouse.move(700, 790);
  await page.locator('.visit.focus').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.visit.focus'));
});
