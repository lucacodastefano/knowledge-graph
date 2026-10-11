import { test, after } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { SqliteRepository } from '../src/core/sqlite-repository.ts';
import { Tracker } from '../src/core/tracker.ts';
import { buildApp, isAllowedOrigin } from '../src/server/app.ts';

const tracker = new Tracker(new SqliteRepository(':memory:'));
const app = await buildApp({ tracker });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

async function connect() {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
  return client;
}

const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

test('exposes the tracking tools, the instructions prompt and server instructions', async () => {
  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['kc_edit', 'kc_focus', 'kc_link', 'kc_move', 'kc_profile', 'kc_read', 'kc_recall', 'kc_relate', 'kc_remove', 'kc_rename', 'kc_start', 'kc_track', 'kc_tree']);
  assert.equal((await client.listPrompts()).prompts[0].name, 'kc_instructions');
  assert.match(client.getInstructions() ?? '', /kc_track/);
  // Transparent wording: the map is explained to the model, nothing asks to hide it or to copy words verbatim.
  const instr = client.getInstructions() ?? '';
  assert.match(instr, /personal knowledge map/);
  assert.match(instr, /detail: the full text of your answer/);
  assert.match(instr, /tables for comparisons, numbered lists for steps/);
  assert.match(instr, /no kc_focus needed/);
  assert.match(instr, /"On the canvas" means this conversation's map/);
  assert.match(instr, /A parent's detail holds only what concerns the whole/);
  assert.doesNotMatch(instr, /thin: true/);
  assert.doesNotMatch(instr, /invisible|never mention|verbatim|word for word|exactly as you will write/i);
  const track = JSON.stringify((await client.listTools()).tools.find((t) => t.name === 'kc_track')!.inputSchema);
  assert.match(track, /"detail":\{[^}]*Full text of your answer/);
  assert.doesNotMatch(track, /verbatim|word for word/i);
  const skill = readFileSync(new URL('../skills/knowledge-graph/SKILL.md', import.meta.url), 'utf8');
  for (const tool of tools) assert.ok(skill.includes(`\`${tool}\``), `skill should cover ${tool}`);
  await client.close();
});

test('a tracked conversation is readable through the REST API and pushed on the websocket', async () => {
  const client = await connect();
  const ws = new WebSocket(new URL('/ws', base.replace('http', 'ws')));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const received: string[] = [];
  ws.addEventListener('message', (m) => received.push(JSON.parse(String(m.data)).type));

  const { conversation } = json(await client.callTool({ name: 'kc_start', arguments: { title: 'Kafka' } }));
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Kafka', summary: 'Log distribuito.', parent: 'root' }] } });
  await client.callTool({
    name: 'kc_track',
    arguments: { nodes: [{ title: 'Consumer group', summary: 'Consumo in parallelo.', parent: 'kafka' }] },
  });

  const tree = await (await fetch(new URL(`/api/conversations/${conversation}/tree`, base))).json();
  assert.equal(tree.visits.length, 2);
  assert.equal(tree.visits[1].parentVisitId, tree.visits[0].id);

  const concept = await (await fetch(new URL(`/api/concepts/${tree.visits[0].conceptId}`, base))).json();
  assert.equal(concept.visits[0].summary, 'Log distribuito.');

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(received.includes('visit.created'));
  assert.ok(received.includes('focus.changed'));
  ws.close();
  await client.close();
});

test('tracking without kc_start opens a conversation automatically', async () => {
  const client = await connect();
  const before = tracker.repo.listConversations().length;
  const res = await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Solo', summary: 's', parent: 'root' }] } });
  assert.equal(res.isError, undefined);
  assert.equal(tracker.repo.listConversations().length, before + 1);
  await client.close();
});

test('read tools answer from the graph without writing to it', async () => {
  const client = await connect();
  await client.callTool({ name: 'kc_start', arguments: { title: 'Rust' } });
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Borrow checker', summary: 'Regole di prestito.', parent: 'root' }] } });
  const before = tracker.repo.countConcepts();

  const [recalled] = json(await client.callTool({ name: 'kc_recall', arguments: { query: 'borrow checker' } }));
  assert.equal(recalled.name, 'Borrow checker');
  assert.deepEqual(recalled.notes, ['Regole di prestito.']);

  const tree = await client.callTool({ name: 'kc_tree', arguments: {} });
  assert.match((tree as { content: { text: string }[] }).content[0].text, /^Rust .*\n- Borrow checker \*current$/);

  const profile = json(await client.callTool({ name: 'kc_profile', arguments: {} }));
  assert.ok(profile.recent.includes('Borrow checker'));
  assert.equal(tracker.repo.countConcepts(), before);
  await client.close();
});

test('domain errors come back as tool errors, not crashes', async () => {
  const client = await connect();
  const res = await client.callTool({ name: 'kc_focus', arguments: { node: 'missing' } });
  assert.equal(res.isError, true);
  await client.close();
});

test('only local origins are allowed', async () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  const res = await fetch(new URL('/api/conversations', base), { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('kc_track returns the tree and a reminder; parents and kc_move work by title, without merging', async () => {
  const client = await connect();
  const start = await client.callTool({ name: 'kc_start', arguments: { title: 'Piante' } });
  assert.match((start.content as { text: string }[])[1].text, /^Tree: empty\n[^]*call kc_track with its nodes, then write the answer/);
  await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'Annaffiatura', summary: 'Quanta acqua.', parent: 'root' }] } });
  const res = await client.callTool({
    name: 'kc_track',
    arguments: { nodes: [{ title: 'Acqua giusta', summary: 'Né troppa né poca.', parent: 'root' }] },
  });
  const extra = (res.content as { text: string }[])[0].text;
  assert.match(extra, /^Tree:\n- Acqua giusta\n/);
  assert.match(extra, /Saved in the map\. Write your answer now, once\./);
  assert.doesNotMatch(extra, /never mention|silently/i);

  const moved = await client.callTool({ name: 'kc_move', arguments: { node: 'Acqua giusta', parent: 'Annaffiatura' } });
  assert.match((moved.content as { text: string }[])[0].text, /- Annaffiatura\n {2}- Acqua giusta/);
  assert.equal(tracker.repo.listConversations().length > 0, true);
  const cycle = await client.callTool({ name: 'kc_move', arguments: { node: 'Annaffiatura', parent: 'Acqua giusta' } });
  assert.equal(cycle.isError, true);
  const missing = await client.callTool({ name: 'kc_track', arguments: { nodes: [{ title: 'X', summary: 's', parent: 'Nope' }] } });
  assert.equal(missing.isError, true);
  await client.close();
});

test("Luca's case: wrappers are refused, and an existing wrapper is dissolved by kc_remove in one call each", async () => {
  const client = await connect();
  await client.callTool({ name: 'kc_start', arguments: { title: 'Solution architecture' } });
  const track = (nodes: object[]) => client.callTool({ name: 'kc_track', arguments: { nodes } });
  await track([
    { title: 'Integrazione di sistemi', summary: 's', parent: 'root' },
    { title: 'Design Authority e governance', summary: 's', parent: 'root' },
  ]);
  const wrapper = await track([
    { title: "Aspetti dell'integrazione tra sistemi", summary: 's', parent: 'Integrazione di sistemi' },
    { title: 'Latenza', summary: 's', parent: '#0' },
  ]);
  assert.equal(wrapper.isError, true);
  assert.match((wrapper.content as { text: string }[])[0].text, /directly under "Integrazione di sistemi"/);
  const nested = await track([
    { title: 'Design Authority', summary: 's', parent: 'Design Authority e governance' },
    { title: 'Gate', summary: 's', parent: '#0' },
  ]);
  assert.equal(nested.isError, true);

  // Wrappers left by an older version: build them through the canvas corrections, then fix the hierarchy.
  const id = tracker.repo.listConversations().find((c) => c.title === 'Solution architecture')!.id;
  const [aspects] = tracker.track(id, [{ title: 'Aspetti', summary: 's', parent: 'root' }]);
  tracker.track(id, [{ title: 'Latenza', summary: 's', parent: 'Aspetti' }, { title: 'Accoppiamento', summary: 's', parent: 'Aspetti' }]);
  tracker.move(id, aspects.id, 'Integrazione di sistemi');
  tracker.track(id, [{ title: 'Governance board', summary: 's', parent: 'root' }, { title: 'Deroghe', summary: 's', parent: '#0' }]);
  tracker.move(id, 'Governance board', 'Design Authority e governance');

  await client.callTool({ name: 'kc_remove', arguments: { node: 'Aspetti' } });
  const fixed = await client.callTool({ name: 'kc_remove', arguments: { node: 'Governance board' } });
  assert.equal(
    (fixed.content as { text: string }[])[0].text.replace(/ \[.+?\]| \*current/g, '').split('\n').slice(1).join('\n'),
    ['- Integrazione di sistemi', '  - Latenza', '  - Accoppiamento', '- Design Authority e governance', '  - Deroghe'].join('\n'),
  );

  const renamed = await client.callTool({ name: 'kc_rename', arguments: { node: 'Deroghe', title: 'Deroghe ai principi' } });
  assert.match((renamed.content as { text: string }[])[0].text, /- Deroghe ai principi/);
  await client.close();
});

test('detail is always accepted, and Approfondisci shows sub-concepts as sections', async () => {
  const id = tracker.startConversation('Architettura', null).id;
  const [da] = tracker.track(id, [
    { title: 'Design Authority', summary: 'Organo di governo.', parent: 'root', detail: '## Cosa fa\n- decide\n- verifica' },
    { title: 'Gate', summary: 'Punti di controllo.', parent: '#0' },
    { title: 'Gate di design', summary: 'Prima dello sviluppo.', parent: '#1' },
    { title: 'Deroghe', summary: 'Eccezioni motivate.', parent: '#0' },
  ]);
  const page = await (await fetch(new URL(`/api/concepts/${da.conceptId}`, base))).json();
  const [occ] = page.visits;
  assert.equal(occ.detail, '## Cosa fa\n- decide\n- verifica');
  assert.equal(occ.parentTitle, null);
  assert.deepEqual(
    occ.sections.map((s: { title: string; children: { title: string }[] }) => [s.title, s.children.map((c) => c.title)]),
    [['Gate', ['Gate di design']], ['Deroghe', []]],
  );
});

test('kc_track accepts parents defined later in the call; any error says nothing was recorded', async () => {
  const client = await connect();
  try {
    await client.callTool({ name: 'kc_start', arguments: { title: 'Reti' } });
    const ok = await client.callTool({
      name: 'kc_track',
      arguments: { nodes: [{ title: 'Handshake', summary: 's', parent: 'TCP' }, { title: 'TCP', summary: 's', parent: 'root' }] },
    });
    assert.equal(ok.isError, undefined);
    assert.match((ok.content as { text: string }[])[0].text, /- TCP\n {2}- Handshake/);

    const cycle = await client.callTool({
      name: 'kc_track',
      arguments: { nodes: [{ title: 'UDP', summary: 's', parent: 'root' }, { title: 'A', summary: 's', parent: 'B' }, { title: 'B', summary: 's', parent: 'A' }] },
    });
    assert.equal(cycle.isError, true);
    assert.match((cycle.content as { text: string }[])[0].text, /Parent cycle.*Nothing was recorded\. Fix this and call kc_track again/);
    const tree = await client.callTool({ name: 'kc_tree', arguments: {} });
    assert.doesNotMatch((tree.content as { text: string }[])[0].text, /UDP/);
  } finally {
    await client.close();
  }
});

test('memory (D19): kc_start carries a compact profile and the recall rule only while the setting is on', async () => {
  const patch = (body: object) =>
    fetch(new URL('/api/settings', base), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const conv = tracker.startConversation('Memoria', null).id;
  tracker.track(conv, [
    { title: 'Event sourcing', summary: 'Stato come sequenza di eventi.', parent: 'root' },
    { title: 'Proiezioni', summary: 'Viste derivate.', parent: 'Event sourcing' },
    { title: 'Saga', summary: 'Transazioni distribuite.', parent: 'root' },
  ]);
  tracker.relateByName({ concept: 'Event sourcing', superclass: 'Architettura software' });
  tracker.track(tracker.startConversation('Altra chat', null).id, [{ title: 'Event sourcing', summary: 'Di nuovo.', parent: 'root' }]);
  const startText = async (c: Client) => {
    const r = await c.callTool({ name: 'kc_start', arguments: { title: 'Prova' } });
    return (r.content as { text: string }[]).map((p) => p.text).join('\n');
  };

  const on = await connect();
  const withMemory = await startText(on);
  assert.match(withMemory, /User's graph \(\d+ concepts\)/);
  assert.match(withMemory, /Areas: Architettura software \(1\)/);
  assert.match(withMemory, /Most explored: .*Event sourcing/);
  assert.match(on.getInstructions() ?? '', /The user's graph is your memory/);
  assert.match(on.getInstructions() ?? '', /thin:true/);
  const profileLines = withMemory.split('\n').filter((l) => /^(User's graph|Areas|Most explored|Recent)/.test(l));
  assert.ok(profileLines.length <= 4 && profileLines.join('\n').length < 700, 'the profile stays within its cap');
  // A concept with a sub-concept is not superficial; a lone one is.
  const recall = json(await on.callTool({ name: 'kc_recall', arguments: { query: 'Saga' } }));
  assert.equal(recall[0].thin, true);
  assert.equal(json(await on.callTool({ name: 'kc_recall', arguments: { query: 'Event sourcing' } }))[0].thin, undefined);

  assert.deepEqual(await (await patch({ memory: false })).json(), { memory: false });
  const off = await connect();
  const without = await startText(off);
  assert.ok(!/User's graph|Areas:/.test(without), 'no profile when off');
  assert.ok(!/is your memory|kc_relate\(concept, superclass\)/.test(off.getInstructions() ?? ''), 'no memory rule when off');
  console.log(
    `memory tokens (~chars/4): instructions on=${Math.round((on.getInstructions() ?? '').length / 4)} off=${Math.round((off.getInstructions() ?? '').length / 4)}; ` +
      `kc_start on=${Math.round(withMemory.length / 4)} off=${Math.round(without.length / 4)}`,
  );
  await patch({ memory: true });
  await on.close();
  await off.close();
});

test('kc_track answers lean: touched branch, no ids, only what needs a decision', async () => {
  const client = await connect();
  await client.callTool({ name: 'kc_start', arguments: { title: 'Zorbio' } });
  const track = async (nodes: object[]) => {
    const r = await client.callTool({ name: 'kc_track', arguments: { nodes } });
    assert.equal((r.content as unknown[]).length, 1);
    return (r.content as { text: string }[])[0].text;
  };
  // Siblings and the parent of the same call are never reported as similar to each other.
  const first = await track([
    { title: 'Zorbio generale', summary: 's', parent: 'root' },
    { title: 'Zorbio notifiche', summary: 's', parent: '#0' },
    { title: 'Zorbio registro', summary: 's', parent: '#0' },
    { title: 'Zorbio separato', summary: 's', parent: '#0' },
  ]);
  assert.doesNotMatch(first, /[0-9a-f]{8}-[0-9a-f]{4}|false|Similar|Known/);
  assert.match(first, /Saved in the map/);
  // Only the branch touched comes back.
  const second = await track([{ title: 'Zorbio istantanea', summary: 's', parent: 'Zorbio registro' }]);
  assert.match(second, /^Tree:\n- Zorbio generale\n {2}- Zorbio registro\n {4}- Zorbio istantanea\n/);
  assert.doesNotMatch(second, /separato|notifiche/);
  await client.close();
});

test('kc_tree has no ids unless titles repeat, lists relations; kc_read returns a node and its children', async () => {
  const client = await connect();
  await client.callTool({ name: 'kc_start', arguments: { title: 'Albero' } });
  await client.callTool({
    name: 'kc_track',
    arguments: {
      nodes: [
        { title: 'Radice albero', summary: 'La radice.', parent: 'root', detail: 'Testo intero della radice.' },
        { title: 'Foglia albero', summary: 'Una foglia.', parent: '#0', detail: 'Testo della foglia.' },
        { title: 'Altra albero', summary: 'Un\'altra.', parent: '#0' },
      ],
    },
  });
  await client.callTool({ name: 'kc_relate', arguments: { concept: 'Foglia albero', related_to: 'Altra albero', label: 'usa' } });
  const tree = (await client.callTool({ name: 'kc_tree', arguments: {} })) as { content: { text: string }[] };
  assert.doesNotMatch(tree.content[0].text, /\[[0-9a-f]{8}-.*\]\n|\n.*- .*\[[0-9a-f]{8}-/);
  assert.match(tree.content[0].text, /Relations:\n- Foglia albero → Altra albero \(usa\)$/);
  const read = (await client.callTool({ name: 'kc_read', arguments: { node: 'Radice albero' } })) as { content: { text: string }[] };
  assert.match(read.content[0].text, /^# Radice albero\n\nLa radice\.\n\nTesto intero della radice\.\n\nChildren: Foglia albero, Altra albero$/);
  // A concept of another conversation is read from the user's graph.
  const other = await connect();
  await other.callTool({ name: 'kc_start', arguments: { title: 'Altra chat' } });
  const cross = (await other.callTool({ name: 'kc_read', arguments: { node: 'Foglia albero' } })) as { content: { text: string }[] };
  assert.match(cross.content[0].text, /Testo della foglia\./);
  const missing = await other.callTool({ name: 'kc_read', arguments: { node: 'Inesistente xyz' } });
  assert.equal(missing.isError, true);
  // kc_focus on a concept that only lives in the personal graph points to kc_track.
  const focus = (await other.callTool({ name: 'kc_focus', arguments: { node: 'Foglia albero' } })) as { isError?: boolean; content: { text: string }[] };
  assert.equal(focus.isError, true);
  assert.match(focus.content[0].text, /kc_track it here/);
  await client.close();
  await other.close();
});
