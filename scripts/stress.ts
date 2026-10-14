/**
 * Synthetic growth test (analisi/10-limiti-crescita.md). Builds a graph of a given shape in a temp database and prints
 * what the daemon, the MCP texts and (with --browser) the canvas cost. Usage:
 *   node scripts/stress.ts map 1000 [--browser]      one conversation with 1000 nodes
 *   node scripts/stress.ts graph 10000 [--browser]   personal graph of 10000 concepts in maps of 60 nodes
 * CHROMIUM_PATH=/opt/pw-browsers/chromium in the cloud sandbox. Tokens are estimated as characters / 4.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker, type TrackNodeInput } from '../src/core/tracker.ts';
import { Reader } from '../src/core/reader.ts';
import { titleStems } from '../src/core/similarity.ts';
import { buildApp } from '../src/server/app.ts';

const [kind, countArg] = process.argv.slice(2);
const count = Number(countArg);
const withBrowser = process.argv.includes('--browser');
if ((kind !== 'map' && kind !== 'graph') || !count) throw new Error('usage: stress.ts map|graph <count> [--browser]');

// Deterministic vocabulary and text, so runs are comparable.
let seed = 42;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SYL = ['ba', 'ro', 'ti', 'ne', 'ca', 'lu', 'mo', 'se', 'di', 'pa', 'fo', 'ri', 'ga', 'ven', 'tor', 'sca', 'mi', 'zo', 'cos', 'tra'];
const VOCAB: string[] = [];
for (const seen = new Set<string>(); VOCAB.length < 3000; ) {
  const w = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => SYL[Math.floor(rnd() * SYL.length)]).join('');
  // Words that fold to the same stem would read as one concept to the tracker.
  const [stem] = titleStems(w);
  if (w.length >= 4 && !seen.has(stem)) seen.add(stem), VOCAB.push(w);
}
const pick = () => VOCAB[Math.floor(rnd() ** 2 * VOCAB.length)];
const sentence = () => `${Array.from({ length: 9 + Math.floor(rnd() * 8) }, pick).join(' ')}.`;
/** ~1,300 characters of markdown with a heading, a list and a table row: the size of a full answer on one concept. */
const detail = () =>
  `## ${pick()} ${pick()}\n${sentence()} ${sentence()} ${sentence()}\n\n- **${pick()}**: ${sentence()}\n- **${pick()}**: ${sentence()}\n- ${sentence()}\n\n| ${pick()} | ${pick()} |\n|---|---|\n| ${pick()} | ${pick()} |\n\n${sentence()} ${sentence()} ${sentence()}`;
const uniqueTitle = (i: number) => `${VOCAB[i % VOCAB.length]} ${VOCAB[(Math.floor(i / VOCAB.length) * 11 + 5) % VOCAB.length]}`;

const dir = mkdtempSync(join(tmpdir(), 'kg-stress-'));
const dbPath = join(dir, 'graph.db');
const tracker = new Tracker(new SqliteRepository(dbPath));
const reader = new Reader(tracker.repo);
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const tokens = (s: string) => Math.round(s.length / 4);
const out: Record<string, unknown> = { shape: `${kind} ${count}` };

// --- Seeding: batches of 10 nodes, like the model's kc_track calls ---
const MAP_NODES = kind === 'map' ? count : 60;
const maps = kind === 'map' ? 1 : Math.ceil(count / MAP_NODES);
const trackTimes: number[] = [];
let index = 0;
const conversations: string[] = [];
const seedStart = performance.now();
for (let m = 0; m < maps; m++) {
  const conv = tracker.startConversation(`Mappa ${m} ${pick()}`, null);
  conversations.push(conv.id);
  const total = Math.min(MAP_NODES, count - m * MAP_NODES);
  const batch: TrackNodeInput[] = [];
  const flush = () => {
    if (!batch.length) return;
    const t0 = performance.now();
    tracker.track(conv.id, batch.splice(0));
    trackTimes.push(performance.now() - t0);
  };
  for (let i = 0; i < total; i++) {
    // Branching factor 4 inside a map; "#n" points to a node of the same call, the rest to a title saved earlier.
    const parentLocal = i === 0 ? -1 : Math.floor((i - 1) / 4);
    const parent = i === 0 ? 'root' : parentLocal >= Math.floor(i / 10) * 10 ? `#${parentLocal % 10}` : uniqueTitle(index - (i - parentLocal));
    batch.push({ title: uniqueTitle(index), summary: sentence(), detail: detail(), parent, sources: [`https://example.org/doc/${index % 400}`] });
    index++;
    if (batch.length === 10) flush();
  }
  flush();
}
if (kind === 'graph') {
  // A third of the concepts sit under a superclass of ~12 members; a few free relations.
  const all = tracker.repo.getPersonalGraph().concepts;
  for (let i = 0; i + 12 <= all.length / 3; i += 12) tracker.group(`Area ${i / 12} ${pick()}`, all.slice(i, i + 12).map((c) => c.id));
  for (let i = 0; i + 1 < Math.min(all.length, 400); i += 2) tracker.setRelation(all[i].id, all[i + 1].id, true, 'usa', all[i].conversationIds[0]);
}
out.seedSeconds = Math.round((performance.now() - seedStart) / 100) / 10;
trackTimes.sort((a, b) => a - b);
out.trackCallMs = { median: Math.round(trackTimes[Math.floor(trackTimes.length / 2)] * 10) / 10, p95: Math.round(trackTimes[Math.floor(trackTimes.length * 0.95)] * 10) / 10, max: Math.round(trackTimes.at(-1)! * 10) / 10 };
tracker.repo.checkpoint?.();
out.dbMB = Math.round((statSync(dbPath).size / 1e6) * 10) / 10;

// --- What the model pays (tokens) and how long the server takes ---
const last = conversations.at(-1)!;
let t0 = performance.now();
const outline = reader.tree(last, false, true);
const outlineMs = ms(t0);
out.modelTokens = {
  kc_start_resume_or_tree_cut: tokens(outline),
  kc_tree_uncut: tokens(reader.tree(last, false, true, undefined, { depth: 99 })),
  kc_tree_with_summaries_uncut: tokens(reader.tree(last, true, false, undefined, { depth: 99 })),
  kc_recall: tokens(JSON.stringify(reader.recall(last, VOCAB[3]))),
  kc_read_one_node: tokens(reader.read(last, uniqueTitle(index - 5))),
};
out.serverMs = {} as Record<string, number>;
const timed = <T>(label: string, fn: () => T): T => {
  const t = performance.now();
  const r = fn();
  (out.serverMs as Record<string, number>)[label] = ms(t);
  return r;
};
(out.serverMs as Record<string, number>).treeOutline = outlineMs;
timed('getTree', () => tracker.repo.getTree(last));
timed('getPersonalGraph', () => tracker.repo.getPersonalGraph());
timed('searchText', () => reader.searchText(`${VOCAB[10]} ${VOCAB[20]}`));
timed('searchTextOneWord', () => reader.searchText(VOCAB[3]));
timed('searchConcepts', () => reader.search(VOCAB[7]));
timed('searchGraphs', () => reader.searchGraphs(last, `${VOCAB[1]} ${VOCAB[2]}`));
timed('profile', () => reader.profile());
timed('trackOneNode', () => tracker.track(last, [{ title: 'nodo nuovo di prova', summary: 'x.', detail: detail(), parent: 'root' }]));

// --- What the canvas downloads, and how it renders ---
const app = await buildApp({ tracker, webRoot: process.env.WEB_ROOT ?? join(import.meta.dirname, '..', 'web', 'dist') });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const bytes = async (path: string) => {
  const t = performance.now();
  const r = await fetch(`${base}${path}`);
  const body = await r.text();
  return { kb: Math.round(body.length / 1024), ms: ms(t) };
};
out.http = { tree: await bytes(`/api/conversations/${last}/tree`), graph: await bytes('/api/graph'), conversations: await bytes('/api/conversations') };

if (withBrowser) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const frames = async (page: import('playwright').Page) => {
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let prev = performance.now();
      const loop = (t: number) => {
        w.__frames.push(t - prev);
        prev = t;
        if (!w.__stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await page.mouse.move(700, 400);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i < 10 ? -120 : 120);
      await page.waitForTimeout(40);
    }
    const f = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__stop = true;
      return w.__frames.slice(2);
    });
    f.sort((a, b) => a - b);
    return { frameMsMedian: Math.round(f[Math.floor(f.length / 2)]), frameMsP95: Math.round(f[Math.floor(f.length * 0.95)]) };
  };
  const canvas: Record<string, unknown> = {};
  if (kind === 'map') {
    for (const layout of ['radial', 'tree']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
      await page.addInitScript((l) => localStorage.setItem('kg.layout', l), layout);
      const t = performance.now();
      await page.goto(`${base}/#conversazione`);
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid=visit]').length >= n, Math.min(count, 30), { timeout: 120000 });
      const firstNodes = ms(t);
      await page.waitForTimeout(1500);
      const domNodes = await page.locator('[data-testid=visit]').count();
      canvas[layout] = { firstNodesMs: firstNodes, domNodesRendered: domNodes, ...(await frames(page)) };
      await page.close();
    }
  } else {
    const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
    // PROFILE=1: where the main thread spends the load (self time per function, top 12).
    const cdp = process.env.PROFILE ? await page.context().newCDPSession(page) : null;
    await cdp?.send('Profiler.enable');
    await cdp?.send('Profiler.start');
    const t = performance.now();
    await page.goto(`${base}/#personale`);
    await page.getByTestId('concept-count').waitFor({ timeout: 120000 });
    const counterMs = ms(t);
    if (cdp) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
      const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
      const self = new Map<string, number>();
      profile.samples.forEach((id, i) => {
        const f = byId.get(id)!;
        const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
        self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
      });
      canvas.profileTopMs = [...self].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${Math.round(v)} ${k}`);
    }
    await page.waitForTimeout(3000);
    canvas.personal = { counterMs, counter: await page.getByTestId('concept-count').innerText(), ...(await frames(page)) };
    await page.close();
  }
  out.canvas = canvas;
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
await app.close();
rmSync(dir, { recursive: true, force: true });
