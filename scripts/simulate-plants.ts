/**
 * Replays Luca's first Claude Desktop conversation (plants) with the D15 rules and checks the tree.
 * Expected: Annaffiatura -> {Frequenza, Metodo, Acqua giusta, Stagionalità}, one "Acqua giusta".
 * Usage: node scripts/simulate-plants.ts [baseUrl]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'simulator', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', process.argv[2] ?? 'http://127.0.0.1:7777')));
let tree = '';
const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const parts = (res.content as { text: string }[]).map((c) => c.text);
  if (res.isError) throw new Error(`${name}: ${parts[0]}`);
  tree = parts.find((p) => p.startsWith('Tree:'))?.split('\nRecorded.')[0] ?? parts[0];
};
const node = (title: string, parent: string) => ({ title, summary: `${title}: cosa ho spiegato.`, parent });

await call('kc_start', { title: "Cura delle piante d'appartamento" });
await call('kc_track', {
  nodes: [
    node('Cura delle piante', 'root'),
    ...['Luce', 'Annaffiatura', 'Terriccio e vaso', 'Temperatura e umidità', 'Concimazione', 'Segnali di allarme'].map((t) => node(t, '#0')),
  ],
});
await call('kc_track', { nodes: [node('Frequenza', 'Annaffiatura')] });
await call('kc_track', { nodes: [node('Metodo', 'Annaffiatura')] });
await call('kc_track', { nodes: [node('Acqua giusta', 'Annaffiatura')] });
await call('kc_track', { nodes: [node('Stagionalità', 'Annaffiatura')] });
// The model comes back to "Acqua giusta" and tracks it again: same parent, so it is updated, not duplicated.
await call('kc_track', { nodes: [node('Acqua giusta', 'Annaffiatura')] });
// "Leghiamola all'innaffiatura": a move, not a merge.
await call('kc_move', { node: 'Acqua giusta', parent: 'Annaffiatura' });
await client.close();

const expected = '  - Annaffiatura\n    - Frequenza\n    - Metodo\n    - Acqua giusta\n    - Stagionalità\n';
const ok = tree.includes(expected) && tree.split('Acqua giusta').length === 2;
console.log(tree);
console.log(ok ? 'plants replay: OK' : 'plants replay: UNEXPECTED TREE');
process.exit(ok ? 0 : 1);
