/**
 * Plays a scripted multi-turn conversation with a real Gemini model connected to
 * a running daemon over MCP, then the same conversation without tools as a
 * baseline, and prints a JSON report (tool calls per turn, token usage).
 * Free tier friendly: requests are spaced out. Needs GEMINI_API_KEY.
 * Usage: node scripts/gemini-trial.ts [baseUrl] [model] [out.json]
 */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://127.0.0.1:7777';
const model = process.argv[3] ?? 'gemini-3.5-flash';
const out = process.argv[4];
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY is not set');
const gap = Number(process.env.TRIAL_GAP_MS ?? 7000);

const SYSTEM = 'You are a helpful tutor. Answer in the user\'s language, clearly and concisely (max ~150 words unless asked).';

/** Two sessions: a learning conversation, then a new one that picks it up. */
const SESSIONS: string[][] = [
  [
    'Ciao! Come va oggi?',
    "Vorrei capire come funziona l'esposizione in fotografia.",
    "Cos'è il diaframma e cosa c'entra con la profondità di campo?",
    'E il tempo di scatto? Come evito le foto mosse?',
    'Cambiando completamente argomento: come funziona la lievitazione del pane con il lievito madre?',
    "Perché un impasto con più acqua viene con più buchi nella mollica?",
    'Torniamo al diaframma: cosa sono esattamente gli f-stop?',
    'Puoi rispondere un po\' più brevemente da ora in poi?',
    'Questa domanda non tracciarla: se a Roma sono le 15, che ore sono a Tokyo?',
    "Che legame c'è tra ISO e rumore digitale?",
  ],
  [
    "L'altra volta parlavamo di fotografia: riprendiamo da dove eravamo rimasti?",
    'Spiegami la regola del sole a 16.',
    'Quanto lievito madre mi serve per 500 g di farina?',
  ],
];

type Part = Record<string, unknown>;
type Content = { role: 'user' | 'model'; parts: Part[] };
type Usage = { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number };
const totals = () => ({ requests: 0, input: 0, cached: 0, output: 0, thoughts: 0 });
type Totals = ReturnType<typeof totals>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(body: unknown, t: Totals): Promise<{ content: Content }> {
  for (let attempt = 0; ; attempt++) {
    await sleep(gap);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key! },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { candidates?: { content: Content }[]; usageMetadata?: Usage; error?: { message: string } };
    if (!res.ok || !data.candidates?.[0]?.content) {
      if (attempt < 4 && (res.status === 429 || res.status >= 500)) {
        console.error(`retry ${res.status}: ${data.error?.message?.slice(0, 120)}`);
        await sleep(30_000 * (attempt + 1));
        continue;
      }
      throw new Error(`Gemini ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const u = data.usageMetadata ?? {};
    t.requests++;
    t.input += u.promptTokenCount ?? 0;
    t.cached += u.cachedContentTokenCount ?? 0;
    t.output += u.candidatesTokenCount ?? 0;
    t.thoughts += u.thoughtsTokenCount ?? 0;
    return { content: { role: 'model', parts: data.candidates[0].content.parts ?? [] } };
  }
}

const textOf = (c: Content) => c.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');

async function runWithTools() {
  const t = totals();
  const turns: { session: number; user: string; calls: { name: string; args: unknown; result: string }[]; answer: string }[] = [];
  let declarations: unknown[] = [];
  let instructions = '';
  for (const [s, script] of SESSIONS.entries()) {
    const client = new Client({ name: `gemini-trial-${model}`, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)));
    instructions = client.getInstructions() ?? '';
    const { tools } = await client.listTools();
    declarations = tools.map((tool) => {
      const { $schema, ...schema } = tool.inputSchema as Record<string, unknown>;
      void $schema;
      return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
    });
    const history: Content[] = [];
    for (const user of script) {
      history.push({ role: 'user', parts: [{ text: user }] });
      const calls: (typeof turns)[number]['calls'] = [];
      let answer = '';
      for (let step = 0; step < 8; step++) {
        const { content } = await generate(
          {
            systemInstruction: { parts: [{ text: `${SYSTEM}\n\n${instructions}` }] },
            tools: [{ functionDeclarations: declarations }],
            contents: history,
          },
          t,
        );
        history.push(content);
        answer += textOf(content);
        const fcs = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall as { name: string; args: Record<string, unknown>; id?: string });
        if (!fcs.length) break;
        const responses: Part[] = [];
        for (const fc of fcs) {
          const res = await client.callTool({ name: fc.name, arguments: fc.args ?? {} });
          const result = (res.content as { text: string }[])[0]?.text ?? '';
          calls.push({ name: fc.name, args: fc.args, result: (res.isError ? 'ERROR ' : '') + result });
          responses.push({ functionResponse: { name: fc.name, id: fc.id, response: res.isError ? { error: result } : { result } } });
        }
        history.push({ role: 'user', parts: responses });
      }
      turns.push({ session: s, user, calls, answer });
      if (out) writeFileSync(`${out}.partial`, JSON.stringify({ totals: t, turns }, null, 2));
      console.error(`[${s}] ${user.slice(0, 50)} -> ${calls.map((c) => c.name).join(', ') || '(no tools)'}`);
    }
    await client.close();
  }
  return { totals: t, turns, declarations, instructions };
}

async function runBaseline() {
  const t = totals();
  for (const script of SESSIONS) {
    const history: Content[] = [];
    for (const user of script) {
      history.push({ role: 'user', parts: [{ text: user }] });
      const { content } = await generate({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: history }, t);
      history.push(content);
    }
  }
  return { totals: t };
}

async function countTokens(body: unknown): Promise<number> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key! },
    body: JSON.stringify({ generateContentRequest: { model: `models/${model}`, ...(body as object) } }),
  });
  const data = (await res.json()) as { totalTokens?: number };
  return data.totalTokens ?? -1;
}

const withTools = await runWithTools();
const baseline = process.env.TRIAL_SKIP_BASELINE ? null : await runBaseline();
const probe = { contents: [{ role: 'user', parts: [{ text: 'ciao' }] }] };
const fixed = {
  plain: await countTokens({ ...probe, systemInstruction: { parts: [{ text: SYSTEM }] } }),
  withToolsAndInstructions: await countTokens({
    ...probe,
    systemInstruction: { parts: [{ text: `${SYSTEM}\n\n${withTools.instructions}` }] },
    tools: [{ functionDeclarations: withTools.declarations }],
  }),
};
const report = { model, fixed, withTools: { totals: withTools.totals, turns: withTools.turns }, baseline: baseline?.totals };
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ model, fixed, withTools: withTools.totals, baseline: baseline?.totals }, null, 2));
