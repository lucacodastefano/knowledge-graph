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

const tracker = new Tracker(new SqliteRepository(join(tmpdir(), `kg-e2e-${process.pid}.db`)));
const app = await buildApp({
  tracker,
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
  assert.match(await page.getByRole('tooltip').innerText(), /Doppio clic sul nodo per approfondire/);
  assert.equal(await page.getByRole('tooltip').getByRole('button').count(), 0, 'no Approfondisci button any more');
  await titled(page, /^Partizioni$/).first().dblclick();
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
  assert.equal(await page.locator('[data-testid=visit] .source-badge').count(), 1, 'one node cites a source');
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
  // No tooltip: hovering opens the Approfondisci panel on the node.
  assert.equal(await page.getByRole('tooltip').count(), 0);
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.locator('.visits li').nth(2).waitFor();
  await page.screenshot({ path: join(out, '7-grafo-hover.png') });

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
    await titled(page, title).dblclick();
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

test('XMind gestures: drag a node onto another to move it with its children, pull a line to relate two concepts', async () => {
  const conv = tracker.startConversation('Gesti XMind', null);
  tracker.track(conv.id, [
    { title: 'Radice gesti', summary: 'r' },
    { title: 'Ramo uno', summary: 'a', parent: '#0' },
    { title: 'Figlio del ramo', summary: 'f', parent: '#1' },
    { title: 'Ramo due', summary: 'b', parent: '#0' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  await page.locator('[data-testid=visit]').nth(3).waitFor();
  await page.waitForTimeout(600);
  const state = async () =>
    (await (await fetch(`${base}/api/conversations/${conv.id}/tree`)).json()) as {
      visits: { id: string; title: string; conceptId: string; parentVisitId: string | null }[];
      relations: unknown[];
    };
  const centre = async (title: string) => {
    const box = (await titled(page, title).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  // Drag "Ramo uno" (with its child) onto "Ramo due".
  const from = await centre('Ramo uno');
  const to = await centre('Ramo due');
  await page.mouse.move(from.x, from.y + 10);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(async ([base, id]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    const byTitle = (n: string) => t.visits.find((v: { title: string }) => v.title === n);
    return byTitle('Ramo uno').parentVisitId === byTitle('Ramo due').id;
  }, [base, conv.id]);
  let t = await state();
  const uno = t.visits.find((v) => v.title === 'Ramo uno')!;
  assert.equal(t.visits.find((v) => v.title === 'Figlio del ramo')!.parentVisitId, uno.id, 'the child travels with its node');
  // Nodes keep the place they were dropped in; switching layout explicitly tidies them up.
  await page.getByLabel('Layout').selectOption('tree');
  await page.waitForTimeout(1000);

  // Pull a line from "Radice gesti" to "Figlio del ramo": a free relation, drawn in the tree.
  // Nodes keep their places now, so the tooltip of the last hovered node may cover this one: close it first.
  await page.mouse.move(700, 800);
  await page.waitForTimeout(500);
  await titled(page, 'Radice gesti').hover({ force: true });
  const handles = titled(page, 'Radice gesti').locator('.react-flow__handle.source');
  const target = await centre('Figlio del ramo');
  const src = await centre('Radice gesti');
  const side = target.x >= src.x ? 'right' : 'left';
  const hb = (await handles.locator(`xpath=self::*[contains(@class,"${side}")]`).boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  // Drop on the facing handle of the other node.
  const facing = (await titled(page, 'Figlio del ramo').locator(`.react-flow__handle.target.${side === 'right' ? 'left' : 'right'}`).boundingBox())!;
  await page.mouse.move(facing.x + facing.width / 2, facing.y + facing.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator('.react-flow__edge.relation').waitFor();
  t = await state();
  assert.equal(t.relations.length, 1);
  await page.screenshot({ path: join(out, '12-gesti-xmind.png') });

  // Touching nodes never moves the view.
  const viewport = () => page.locator('.react-flow__viewport').getAttribute('style');
  const before = await viewport();
  await titled(page, 'Ramo due').click();
  await page.waitForTimeout(500);
  assert.equal(await viewport(), before, 'a click does not zoom to another node');

  // Click the relation: a red ✕ appears; Canc removes it too; Ctrl+Z brings it back, Ctrl+Y removes it again.
  // Click along the dotted line until a point is not covered by a node: the red ✕ appears.
  // Nodes and their hover toolbars can cover any point of a line, so the click goes straight to the edge.
  const armEdge = async (path: ReturnType<typeof page.locator>, _button: string) => {
    await path.locator('xpath=ancestor::*[contains(@class,"react-flow__edge")][1]').locator('.react-flow__edge-interaction').dispatchEvent('click');
  };
  await armEdge(page.locator('.react-flow__edge.relation .react-flow__edge-path').first(), 'Rimuovi la relazione');
  await page.getByRole('button', { name: 'Rimuovi la relazione' }).waitFor();
  const places = async () =>
    Promise.all(['Radice gesti', 'Ramo uno', 'Figlio del ramo', 'Ramo due'].map(async (n) => {
      const b = (await titled(page, n).boundingBox())!;
      return `${Math.round(b.x)},${Math.round(b.y)}`;
    }));
  const placesBefore = await places();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => !document.querySelector('.react-flow__edge.relation'));
  await page.waitForTimeout(700);
  assert.deepEqual(await places(), placesBefore, 'removing a relation moves no node');
  assert.equal((await state()).relations.length, 0);
  await page.keyboard.press('Control+z');
  await page.locator('.react-flow__edge.relation').waitFor();
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => !document.querySelector('.react-flow__edge.relation'));
  // Undo also walks back the move: "Ramo uno" returns under "Radice gesti".
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(async ([base, id]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    const byTitle = (n: string) => t.visits.find((v: { title: string }) => v.title === n);
    return byTitle('Ramo uno').parentVisitId === byTitle('Radice gesti').id;
  }, [base, conv.id]);

  // A solid parent-child edge can be removed too: the child leaves its parent with its subtree; Ctrl+Z restores it.
  await page.waitForTimeout(800);
  t = await state();
  const kid = t.visits.find((v) => v.title === 'Figlio del ramo')!;
  const oldParent = kid.parentVisitId;
  const placesPreDetach = await places();
  const edge = page.locator(`.react-flow__edge[data-id="t-${kid.id}"] .react-flow__edge-path`);
  await armEdge(edge, 'Scollega il nodo');
  await page.getByRole('button', { name: 'Scollega il nodo' }).waitFor();
  await page.keyboard.press('Delete');
  await page.waitForFunction(async ([base, id, kidId]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    return t.visits.find((v: { id: string }) => v.id === kidId).parentVisitId === null;
  }, [base, conv.id, kid.id]);
  assert.equal((await state()).visits.length, 4, 'nothing is deleted');
  await page.waitForTimeout(700);
  assert.deepEqual(await places(), placesPreDetach, 'a detached child stays where it is');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(async ([base, id, kidId, parent]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    return t.visits.find((v: { id: string }) => v.id === kidId).parentVisitId === parent;
  }, [base, conv.id, kid.id, oldParent]);
  await page.close();
});

test('dragging a node near another previews the attachment, releasing attaches it, and out of range nothing changes', async () => {
  const conv = tracker.startConversation('Giunzione', null);
  tracker.track(conv.id, [
    { title: 'Alfa', summary: 'a' },
    { title: 'Beta', summary: 'b', parent: '#0' },
    { title: 'Gamma', summary: 'g', parent: '#0' },
    { title: 'Delta', summary: 'd', parent: '#2' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  await titled(page, 'Delta').waitFor();
  await page.waitForTimeout(900);
  const parentOf = async (title: string) => {
    const t = (await (await fetch(`${base}/api/conversations/${conv.id}/tree`)).json()) as { visits: { id: string; title: string; parentVisitId: string | null }[] };
    const v = t.visits.find((x) => x.title === title)!;
    return t.visits.find((x) => x.id === v.parentVisitId)?.title ?? null;
  };
  const box = async (title: string) => (await titled(page, title).boundingBox())!;
  const centre = async (title: string) => {
    const b = await box(title);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // A point of the node that nothing (its hover toolbar) covers.
  const grab = async (title: string) => {
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const b = await box(title);
    for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      for (const g of [0.5, 0.2, 0.8]) {
        const x = b.x + b.width * f;
        const y = b.y + b.height * g;
        const ok = await page.evaluate(([x, y, t]) => {
          const e = document.elementFromPoint(x, y);
          return !!e && !e.closest('.react-flow__node-toolbar') && !!e.closest('.react-flow__node') && (e.closest('.react-flow__node')?.textContent ?? '').includes(t);
        }, [x, y, title] as [number, number, string]);
        if (ok) return { x, y };
      }
    }
    throw new Error(`no free point on ${title}`);
  };
  const preview = page.locator('.react-flow__edge.preview');
  assert.equal(await parentOf('Beta'), 'Alfa');

  // Tree layout: the magnetic zones are the short sides. Hold Beta and bring its left end next to Gamma's right end.
  await page.getByLabel('Layout').selectOption('tree');
  await page.waitForTimeout(900);
  const g = await box('Gamma');
  const bb = await box('Beta');
  // A node that still has a parent never snaps: no preview, even right against the other end.
  await page.mouse.move(bb.x + 20, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width + 8 + 20, g.y + g.height / 2, { steps: 12 });
  await page.waitForTimeout(200);
  assert.equal(await preview.count(), 0, 'a node with a parent does not preview an attachment');
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  // Detached, Beta has a free end: a 30 px gap is too far, 8 px snaps.
  const betaId = (await (await fetch(`${base}/api/conversations/${conv.id}/tree`)).json() as { visits: { id: string; title: string }[] }).visits.find((v) => v.title === 'Beta')!.id;
  await fetch(`${base}/api/visits/${betaId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentVisitId: null }) });
  await page.waitForFunction(async ([base, id]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    return t.visits.find((v: { title: string }) => v.title === 'Beta').parentVisitId === null;
  }, [base, conv.id]);
  await page.waitForTimeout(900);
  const bf = await box('Beta');
  const gf = await box('Gamma');
  await page.mouse.move(bf.x + 20, bf.y + bf.height / 2);
  await page.mouse.down();
  await page.mouse.move(gf.x + gf.width + 60 + 20, gf.y + gf.height / 2, { steps: 12 });
  await page.waitForTimeout(200);
  assert.equal(await preview.count(), 0, 'no snap 60 px away');
  await page.mouse.move(gf.x + gf.width + 8 + 20, gf.y + gf.height / 2, { steps: 6 });
  await preview.waitFor();
  assert.equal(await parentOf('Beta'), null, 'nothing changes while the button is held');
  await page.screenshot({ path: join(out, '14-anteprima-giunzione.png') });
  await page.mouse.up();
  await page.waitForFunction(async ([base, id]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    const byTitle = (n: string) => t.visits.find((v: { title: string }) => v.title === n);
    return byTitle('Beta').parentVisitId === byTitle('Gamma').id;
  }, [base, conv.id]);
  await preview.waitFor({ state: 'detached' });
  await page.waitForTimeout(900);

  // A parent carries its whole subtree rigidly, live and after release; Ctrl+Z puts all of it back.
  const names = ['Gamma', 'Beta', 'Delta'];
  const offsets = async () => {
    const [g0, ...rest] = await Promise.all(names.map(centre));
    return rest.map((c) => ({ x: Math.round(c.x - g0.x), y: Math.round(c.y - g0.y) }));
  };
  const rigidBefore = await offsets();
  const g1 = await centre('Gamma');
  const alfa = await box('Alfa');
  const spot = [{ x: 100, y: 700 }, { x: 1300, y: 700 }, { x: 1300, y: 120 }].find(
    (q) => Math.hypot(q.x - (alfa.x + alfa.width / 2), q.y - (alfa.y + alfa.height / 2)) > 400,
  )!;
  const gp = await grab('Gamma');
  await page.mouse.move(gp.x, gp.y);
  await page.mouse.down();
  await page.mouse.move((g1.x + spot.x) / 2, (g1.y + spot.y) / 2, { steps: 8 });
  await page.mouse.move(spot.x, spot.y, { steps: 8 });
  assert.deepEqual(await offsets(), rigidBefore, 'the subtree moves rigidly while dragging');
  await page.mouse.up();
  await page.waitForTimeout(600);
  assert.deepEqual(await offsets(), rigidBefore, 'and stays rigid after the release');
  assert.ok(Math.abs((await centre('Gamma')).x - g1.x) > 100, 'it really moved');
  assert.equal(await parentOf('Beta'), 'Gamma');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const g2 = await centre('Gamma');
  assert.ok(Math.abs(g2.x - g1.x) < 2 && Math.abs(g2.y - g1.y) < 2, 'Ctrl+Z puts the block back');
  assert.deepEqual(await offsets(), rigidBefore);

  // Far from every node: no preview, and releasing changes nothing.
  const boxes = await Promise.all(['Alfa', 'Beta', 'Gamma', 'Delta'].map(box));
  const far = [{ x: 60, y: 760 }, { x: 1340, y: 760 }, { x: 1340, y: 140 }, { x: 700, y: 790 }].find((p) =>
    boxes.every((r) => Math.hypot(Math.max(0, r.x - p.x, p.x - (r.x + r.width)), Math.max(0, r.y - p.y, p.y - (r.y + r.height))) > 220),
  )!;
  assert.ok(far, 'an empty corner exists');
  const d = await centre('Delta');
  const before = await parentOf('Delta');
  const dp = await grab('Delta');
  await page.mouse.move(dp.x, dp.y);
  await page.mouse.down();
  await page.mouse.move(far.x, far.y, { steps: 14 });
  assert.equal(await preview.count(), 0, 'no preview out of range');
  await page.mouse.up();
  await page.waitForTimeout(600);
  assert.equal(await parentOf('Delta'), before);

  // Ctrl+Z twice: the position of Delta, then the attach (Beta is free again).
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(async ([base, id]) => {
    const t = await (await fetch(`${base}/api/conversations/${id}/tree`)).json();
    const byTitle = (n: string) => t.visits.find((v: { title: string }) => v.title === n);
    return byTitle('Beta').parentVisitId === null;
  }, [base, conv.id]);
  await page.close();
});

test('hovering an edge lifts it with its label and fades what covers it; dragging a node closes the panel and the tooltip', async () => {
  const conv = tracker.startConversation('Archi', null);
  tracker.track(conv.id, [
    { title: 'Radice archi', summary: 'r' },
    { title: 'Ramo uno', summary: 'u', parent: '#0' },
    { title: 'Ramo due', summary: 'd', parent: '#0' },
  ]);
  const ids = (await (await fetch(`${base}/api/conversations/${conv.id}/tree`)).json() as { visits: { title: string; conceptId: string }[] }).visits;
  const c = (t: string) => ids.find((v) => v.title === t)!.conceptId;
  await fetch(`${base}/api/relations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: c('Ramo uno'), to: c('Ramo due'), label: 'si oppone a' }),
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(base);
  await titled(page, 'Ramo due').waitFor();
  await page.waitForTimeout(900);
  const rel = page.locator('.react-flow__edge.relation .react-flow__edge-path').first();
  await rel.waitFor({ state: 'attached' });
  await rel.hover({ force: true });
  await page.locator('.react-flow__edge.hover').waitFor({ state: 'attached', timeout: 5000 });
  assert.ok((await page.locator('.relation-label.hover').innerText()).includes('si oppone a'));
  assert.equal(await titled(page, 'Ramo uno').evaluate((e) => e.classList.contains('cover')), false, 'endpoints stay opaque');
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector('.react-flow__edge.hover'));

  // Double click opens the panel; starting a drag closes it, and no tooltip stays.
  await titled(page, 'Ramo uno').dblclick();
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.waitFor();
  const b = (await titled(page, 'Ramo due').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + 160, { steps: 6 });
  await panel.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('tooltip').count(), 0);
  await page.mouse.up();

  // Canc deletes the selected node after a confirmation; its children move up.
  await titled(page, 'Ramo uno').click();
  page.once('dialog', (d) => void d.accept());
  await page.keyboard.press('Delete');
  await titled(page, 'Ramo uno').waitFor({ state: 'detached' });
  await page.close();
});

test('personal graph: the panel follows the hover, a click locks it, Esc or an empty click unlocks it', async () => {
  const conv = tracker.startConversation('Prova hover', null);
  tracker.track(conv.id, [
    { title: 'Alfa', summary: 'Primo nodo.', parent: 'root' },
    { title: 'Beta', summary: 'Secondo nodo.', parent: 'Alfa' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(`${base}/#personale`);
  await page.getByTestId('concept-count').waitFor();
  await page.waitForTimeout(500);
  const box = (await page.getByTestId('personal-graph').boundingBox())!;
  const at = (label: string) =>
    page.evaluate(
      `window.__kgPersonal.position(${JSON.stringify(label)})`,
    ) as Promise<{ x: number; y: number }>;
  const panel = page.getByLabel('Dettaglio concetto');
  // Pan the canvas so both nodes sit left of the panel docked on the right (the layout is random).
  const [a, b] = [await at('Alfa'), await at('Beta')];
  const dx = 500 - (a.x + b.x) / 2;
  await page.mouse.move(box.x + 700, box.y + box.height - 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 700 + dx, box.y + box.height - 20, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const move = async (label: string) => {
    const p = await at(label);
    await page.mouse.move(box.x + p.x, box.y + p.y, { steps: 4 });
  };

  // Hover mode: the panel opens on the node and updates in place when the pointer moves to another.
  await move('Alfa');
  await panel.locator('h2', { hasText: 'Alfa' }).waitFor();
  assert.equal(await panel.getByText('fissato').count(), 0, 'not pinned while following the hover');
  await move('Beta');
  await panel.locator('h2', { hasText: 'Beta' }).waitFor();

  // Focus mode: a click locks the panel, hovering elsewhere no longer changes it.
  await page.mouse.click(box.x + (await at('Beta')).x, box.y + (await at('Beta')).y);
  await panel.getByText('fissato').waitFor();
  await move('Alfa');
  await page.waitForTimeout(900);
  assert.equal(await panel.locator('h2').innerText(), 'Beta');

  // Esc leaves focus mode and closes the panel until the next hover.
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  await page.mouse.move(box.x + 700, box.y + box.height - 20);
  await move('Alfa');
  await panel.locator('h2', { hasText: 'Alfa' }).waitFor();

  // A click on empty canvas also unlocks.
  await page.mouse.click(box.x + (await at('Alfa')).x, box.y + (await at('Alfa')).y);
  await panel.getByText('fissato').waitFor();
  await page.mouse.move(box.x + 700, box.y + box.height - 20);
  await page.waitForTimeout(500); // not a double click with the click that locked the panel
  await page.mouse.click(box.x + 700, box.y + box.height - 20);
  await panel.waitFor({ state: 'detached' });

  // Editing implies focus: it survives hovering elsewhere, and Esc cancels the edit before leaving focus.
  await move('Alfa');
  await panel.locator('h2', { hasText: 'Alfa' }).waitFor();
  await panel.getByRole('button', { name: 'Modifica' }).click();
  await panel.getByLabel('Nome del concetto').waitFor();
  await move('Beta');
  await page.waitForTimeout(900);
  assert.equal(await panel.getByLabel('Nome del concetto').inputValue(), 'Alfa');
  await page.keyboard.press('Escape');
  await panel.getByLabel('Nome del concetto').waitFor({ state: 'detached' });
  assert.equal(await panel.count(), 1, 'the first Esc only cancels the edit');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
});
