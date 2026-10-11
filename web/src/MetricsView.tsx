import { useEffect, useState } from 'react';
import { api, type Conversation, type Metrics, type Period } from './api.ts';
import type { LiveEvent } from './App.tsx';

const PERIODS: [Period, string][] = [
  ['24h', 'Ultime 24 ore'],
  ['7d', 'Ultimi 7 giorni'],
  ['30d', 'Ultimi 30 giorni'],
  ['all', 'Tutto'],
];
const REFRESH_MS = 15_000;
const W = 560;
const H = 190;
const PAD = { l: 44, r: 12, t: 10, b: 24 };

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** Dependency-free SVG chart with numeric axes: x = graph size, y = tokens. `line` joins the points in time order, otherwise they are dots. */
function XYChart({ points, line, xName, yName, testId }: { points: { x: number; y: number }[]; line?: boolean; xName: string; yName: string; testId: string }) {
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const maxY = Math.max(1, ...points.map((p) => p.y));
  const x = (v: number) => PAD.l + (v / maxX) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / maxY) * (H - PAD.t - PAD.b);
  return (
    <div data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(f * maxY)} y2={y(f * maxY)} className="grid" />
            <text x={PAD.l - 6} y={y(f * maxY) + 4} textAnchor="end" className="axis">{fmt(f * maxY)}</text>
            <text x={x(f * maxX)} y={H - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'} className="axis">{fmt(f * maxX)}</text>
          </g>
        ))}
        {line && points.length > 1 ? (
          <polyline points={points.map((p) => `${x(p.x)},${y(p.y)}`).join(' ')} fill="none" stroke="var(--c1)" strokeWidth={2} />
        ) : (
          points.map((p, i) => <circle key={i} cx={x(p.x)} cy={y(p.y)} r={3} fill="var(--c2)" fillOpacity={0.6} />)
        )}
      </svg>
      <div className="chart-legend"><span>x: {xName}</span><span>y: {yName}</span></div>
    </div>
  );
}

/** Horizontal bars, one row per item. */
function Bars({ rows, unit = '', testId }: { rows: { name: string; value: number; extra?: string }[]; unit?: string; testId: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="m-empty">Ancora nessun dato.</p>;
  return (
    <div className="bars" data-testid={testId}>
      {rows.map((r) => (
        <div key={r.name} className="bar-row" title={r.extra}>
          <span className="bar-name">{r.name}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="bar-value">{fmt(r.value)}{unit}</span>
        </div>
      ))}
    </div>
  );
}

function Card({ title, caption, children, wide }: { title: string; caption: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`metric-card ${wide ? 'wide' : ''}`}>
      <h3>{title}</h3>
      <p className="caption">{caption}</p>
      {children}
    </section>
  );
}

const Stat = ({ value, name }: { value: string; name: string }) => (
  <div className="stat"><strong>{value}</strong><span>{name}</span></div>
);
const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '–');

export function MetricsView({ live }: { live: LiveEvent | null }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState('');
  const [period, setPeriod] = useState<Period>('24h');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => void api.conversations().then(setConversations, () => undefined), [live?.seq]);
  useEffect(() => {
    let stop = false;
    const load = () => api.metrics(conversation, period).then((m) => !stop && (setMetrics(m), setFailed(false)), () => !stop && setFailed(true));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [conversation, period, live?.seq]);

  const m = metrics;
  return (
    <div className="metrics" data-testid="metrics">
      <div className="metrics-head">
        <h2>Metriche</h2>
        <select aria-label="Grafo" value={conversation} onChange={(e) => setConversation(e.target.value)}>
          <option value="">Tutti i grafi</option>
          {conversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
        <select aria-label="Periodo" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          {PERIODS.map(([p, l]) => <option key={p} value={p}>{l}</option>)}
        </select>
      </div>
      <p className="metrics-note">
        I token sono una stima (caratteri ÷ 3,5) e contano solo il traffico da e verso il grafo: non il ragionamento del modello, le ricerche web, la risposta in chat o il contesto.
        I dati si accumulano dall’aggiornamento che ha introdotto le metriche.
      </p>
      {failed && !m && <p className="m-empty">Impossibile leggere le metriche.</p>}
      {m && (
        <>
          <div className="stats">
            <Stat value={fmt(m.tokens.written)} name="token scritti dal modello" />
            <Stat value={fmt(m.tokens.read)} name="token letti dagli strumenti" />
            <Stat value={String(m.tokens.calls)} name="chiamate" />
            <Stat value={String(m.efficiency.nodesCreated)} name="nodi creati" />
            <Stat value={m.efficiency.tokensPerNode === null ? '–' : fmt(m.efficiency.tokensPerNode)} name="token per nodo" />
          </div>
          <div className="metric-grid">
            <Card title="Costo cumulato e dimensione" caption="Quanti token sono costati i nodi del grafo: token spesi fin qui (y) contro numero di nodi (x).">
              {m.size.length === 0 ? <p className="m-empty">Ancora nessuna chiamata nel periodo.</p> : (
                <XYChart testId="chart-cost-size" line xName="nodi nel grafo" yName="token cumulati" points={m.size.map((p) => ({ x: p.nodes, y: p.cumTokens }))} />
              )}
            </Card>
            <Card title="Costo per nodo e dimensione" caption="Ogni punto è una chiamata che ha creato nodi: se i punti salgono, aggiungere nodi costa di più man mano che il grafo cresce.">
              {m.size.every((p) => p.perNode === null) ? <p className="m-empty">Ancora nessun nodo creato nel periodo.</p> : (
                <XYChart testId="chart-pernode-size" xName="nodi nel grafo" yName="token per nodo creato" points={m.size.flatMap((p) => (p.perNode === null ? [] : [{ x: p.nodes, y: p.perNode }]))} />
              )}
            </Card>
            <Card title="Token per strumento" caption="Dove va il costo: token scritti più letti da ogni strumento.">
              <Bars testId="chart-tools" rows={m.tools.map((t) => ({ name: t.tool, value: t.written + t.read, extra: `${t.calls} chiamate · scritti ${t.written} · letti ${t.read}` }))} />
            </Card>
            <Card title="Efficienza" caption="Costo medio di un nodo e riscritture inutili: kc_track che non crea nulla contro modifiche parziali con kc_edit.">
              <div className="stats small">
                <Stat value={m.efficiency.tokensPerNode === null ? '–' : fmt(m.efficiency.tokensPerNode)} name="token per nodo creato" />
                <Stat value={String(m.efficiency.rewrites)} name="riscritture complete" />
                <Stat value={String(m.efficiency.partialEdits)} name="modifiche parziali" />
              </div>
            </Card>
            <Card title="Errori e durata" caption="Chiamate fallite e tempi per strumento: segnala strumenti fragili o lenti.">
              {m.tools.length === 0 ? <p className="m-empty">Ancora nessun dato.</p> : (
                <table className="mini" data-testid="table-errors">
                  <thead><tr><th>Strumento</th><th>Chiamate</th><th>Errori</th><th>Media</th><th>Max</th></tr></thead>
                  <tbody>
                    {m.tools.map((t) => (
                      <tr key={t.tool} className={t.errors ? 'bad' : ''}><td>{t.tool}</td><td>{t.calls}</td><td>{t.errors}</td><td>{t.avgMs} ms</td><td>{t.maxMs} ms</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Memoria in uso" caption="Il modello rilegge il grafo? Chiamate a kc_recall e kc_read e quante trovano qualcosa.">
              <div className="stats small" data-testid="memory">
                <Stat value={`${m.memory.recall.hits}/${m.memory.recall.calls}`} name={`kc_recall con risultato (${pct(m.memory.recall.hits, m.memory.recall.calls)})`} />
                <Stat value={`${m.memory.read.hits}/${m.memory.read.calls}`} name={`kc_read con risultato (${pct(m.memory.read.hits, m.memory.read.calls)})`} />
              </div>
            </Card>
            <Card wide title="Qualità del grafo" caption="Lacune da colmare: nodi senza testo o fonti, concetti senza superclasse, titoli simili, forma dell’albero.">
              <div className="quality" data-testid="quality">
                <div className="stats small">
                  <Stat value={`${m.quality.withoutDetail}/${m.quality.nodes}`} name="nodi senza dettaglio" />
                  <Stat value={`${m.quality.withoutSources}/${m.quality.nodes}`} name="nodi senza fonti" />
                  <Stat value={`${m.quality.withoutSuperclass}/${m.quality.concepts}`} name="concetti senza superclasse" />
                </div>
                <div>
                  <h4>Possibili duplicati</h4>
                  {m.quality.duplicates.length === 0 ? <p className="m-empty">Nessuno.</p> : (
                    <ul>{m.quality.duplicates.map(([a, b]) => <li key={a + b}>{a} ≈ {b}</li>)}</ul>
                  )}
                </div>
                <div>
                  <h4>Nodi per livello</h4>
                  <p className="caption">Quanti nodi stanno a ciascun livello dell’albero: barre lunghe ai primi livelli indicano un grafo largo e poco approfondito.</p>
                  <Bars testId="chart-depth" rows={m.quality.depth.map((n, i) => ({ name: `Livello ${i + 1}`, value: n }))} />
                  <div className="stats small">
                    <Stat value={String(m.quality.maxDepth)} name="profondità massima (livelli)" />
                    <Stat value={m.quality.avgChildren === null ? '–' : String(m.quality.avgChildren).replace('.', ',')} name="figli medi per nodo che ha figli" />
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
