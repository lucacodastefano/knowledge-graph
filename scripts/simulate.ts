/**
 * Plays a scripted learning conversation against a running daemon, the way a
 * model would call the tools. Usage: node scripts/simulate.ts [baseUrl] [delayMs]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://127.0.0.1:7777';
const delay = Number(process.argv[3] ?? 600);
const wait = () => new Promise((r) => setTimeout(r, delay));

const client = new Client({ name: 'simulator', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0].text;
  if (res.isError) throw new Error(`${name}: ${text}`);
  await wait();
  return text;
};

await call('kc_start', { title: 'Kafka e architetture a eventi' });
await call('kc_track', {
  nodes: [{ title: 'Apache Kafka', summary: 'Log distribuito e replicato per stream di eventi: i producer scrivono su topic, i consumer leggono in ordine.', parent: 'root' }],
});
await call('kc_track', {
  nodes: [
    { title: 'Topic', summary: 'Categoria logica di eventi, divisa in partizioni.', parent: 'Apache Kafka' },
    { title: 'Partizioni', summary: 'Unità di parallelismo e ordinamento: l\'ordine è garantito solo dentro una partizione.', parent: '#0' },
  ],
});
await call('kc_track', {
  nodes: [{ title: 'Chiave di partizionamento', summary: 'La chiave del messaggio decide la partizione: stessa chiave, stessa partizione, ordine garantito.', parent: 'Partizioni' }],
});
await call('kc_focus', { node: 'Apache Kafka' });
await call('kc_track', {
  nodes: [{ title: 'Consumer group', summary: 'Consumer che si dividono le partizioni di un topic: ogni partizione è letta da un solo membro del gruppo.', parent: 'Apache Kafka' }],
});
await call('kc_track', {
  nodes: [
    { title: 'Rebalancing', summary: 'Riassegnazione delle partizioni quando un consumer entra o esce dal gruppo.', parent: 'Consumer group' },
    { title: 'Offset', summary: 'Posizione di lettura per partizione; il commit dell\'offset decide da dove si riparte.', parent: 'Consumer group' },
  ],
});
await call('kc_track', {
  nodes: [{ title: 'Event sourcing', summary: 'Lo stato si ricava riapplicando la sequenza di eventi invece di salvarlo direttamente.', parent: 'root' }],
});
await call('kc_track', {
  nodes: [
    { title: 'Partizioni', summary: 'In event sourcing si partiziona per id dell\'aggregato, così gli eventi di un aggregato restano ordinati.', excerpt: 'key = aggregateId → stessa partizione → ordine garantito per aggregato', parent: 'Event sourcing', sources: ['https://kafka.apache.org/documentation/?utm_source=chat#intro'] },
  ],
});
await call('kc_track', {
  nodes: [{ title: 'Snapshot dello stato', summary: 'Fotografia periodica dello stato per non riapplicare tutti gli eventi.', parent: 'Event sourcing' }],
});
await call('kc_track', {
  nodes: [{ title: 'Proiezioni di lettura', summary: 'Viste materializzate costruite dagli eventi, ottimizzate per le query (CQRS).', parent: 'Event sourcing' }],
});
// A near-duplicate: the server reports similar concepts, the "model" merges it.
const dup = await call('kc_track', {
  nodes: [{ title: 'Partizioni Kafka', summary: 'Ripasso: partizioni come unità di parallelismo.', parent: 'Proiezioni di lettura' }],
});
const same = /"Partizioni Kafka" ~ "Partizioni" \(conceptId ([^)]+)\)/.exec(dup)?.[1];
if (same) await call('kc_link', { node: 'Partizioni Kafka', conceptId: same });

console.log(`simulation done: merged=${Boolean(same)}`);
await client.close();
