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

  const node = page.locator('[data-testid=visit]', { hasText: 'Consumer group' });
  await node.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.match(await tooltip.innerText(), /ogni partizione è letta da un solo membro/);
  await page.screenshot({ path: join(out, '4-hover.png') });

  await page.locator('[data-testid=visit]', { hasText: /^Partizioni$/ }).first().hover();
  assert.equal(await page.getByRole('tooltip').count(), 1, 'only one tooltip at a time');
  await page.getByRole('tooltip').getByRole('button', { name: 'Approfondisci' }).click();
  const panel = page.getByLabel('Dettaglio concetto');
  await panel.waitFor();
  // The panel opens before its data arrives: wait for the list, not just the frame.
  await panel.locator('.visits li').nth(2).waitFor();
  assert.equal(await panel.locator('.visits li').count(), 3, 'all visits of the concept, incl. the merged one');
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
      visits: { id: string; title: string; parentVisitId: string | null }[];
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

  // Rename the concept: its node in the tree follows.
  await panel.getByRole('button', { name: 'Rinomina' }).click();
  await panel.getByLabel('Nuovo nome').fill('Consumer groups');
  await panel.getByRole('button', { name: 'Salva' }).click();
  await visits.filter({ hasText: /^Consumer groups$/ }).waitFor();

  // A name already taken is refused with a hint to merge.
  await panel.getByRole('button', { name: 'Rinomina' }).click();
  await panel.getByLabel('Nuovo nome').fill('offset');
  await panel.getByRole('button', { name: 'Salva' }).click();
  assert.match(await panel.getByRole('alert').innerText(), /Esiste già «Offset»/);
  await panel.getByRole('button', { name: 'Annulla' }).click();

  // Merge a concept into another from its panel.
  await page.getByLabel('Cerca concetti').fill('rebal');
  await page.getByRole('option', { name: /Rebalancing/ }).click();
  await panel.getByRole('heading', { name: 'Rebalancing' }).waitFor();
  await panel.getByRole('button', { name: 'Unisci a…' }).click();
  await panel.getByLabel('Unisci a', { exact: true }).fill('consumer');
  await panel.getByRole('option', { name: /Consumer groups/ }).click();
  await panel.getByRole('heading', { name: 'Consumer groups' }).waitFor();
  await panel.locator('.visits li').nth(1).waitFor();
  await panel.getByRole('button', { name: 'Chiudi', exact: true }).click();

  // Edit a single node: move it, rename it, then delete another one.
  const editNode = async (title: string) => {
    await visits.filter({ hasText: title }).hover();
    await page.getByRole('tooltip').getByRole('button', { name: 'Modifica' }).click();
    const p = page.getByLabel('Modifica nodo');
    await p.waitFor();
    return p;
  };
  let edit = await editNode('Snapshot dello stato');
  const kafkaId = (await tree()).visits.find((v) => v.title === 'Apache Kafka')!.id;
  await edit.getByLabel('Sotto').selectOption(kafkaId);
  await edit.getByLabel('Titolo').fill('Snapshot');
  await edit.getByRole('button', { name: 'Salva' }).click();
  await visits.filter({ hasText: /^Snapshot$/ }).waitFor();
  assert.equal((await tree()).visits.find((v) => v.title === 'Snapshot')!.parentVisitId, kafkaId);
  await page.screenshot({ path: join(out, '9-modifica-nodo.png') });
  await edit.getByRole('button', { name: 'Chiudi modifica' }).click();

  edit = await editNode('Proiezioni di lettura');
  await edit.getByRole('button', { name: 'Elimina nodo' }).click();
  await edit.getByRole('button', { name: 'Conferma eliminazione' }).click();
  await edit.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=visit]').length === 11);

  // Delete a whole concept from the personal graph.
  await page.goto(`${base}/#personale`);
  await page.getByTestId('concept-count').waitFor();
  await page.getByLabel('Cerca concetti').fill('Schema reg');
  await page.getByRole('option', { name: /Schema registry/ }).click();
  await panel.getByRole('button', { name: 'Elimina' }).click();
  await panel.getByRole('button', { name: 'Conferma eliminazione' }).click();
  await panel.waitFor({ state: 'detached' });
  // 11 concepts - Rebalancing (merged) - Proiezioni (deleted node) - Schema registry.
  await page.getByText('8 concetti').waitFor();
  await page.screenshot({ path: join(out, '10-grafo-corretto.png') });
});
