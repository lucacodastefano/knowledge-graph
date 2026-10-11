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
const label = (t: string, bucket: 'hour' | 'day') => (bucket === 'hour' ? `${t.slice(11, 13)}:00` : t.slice(5, 10).split('-').reverse().join('/'));

interface Line {
  name: string;
  color: string;
  values: (number | null)[];
}

/** Dependency-free SVG line chart; the x labels are the first, middle and last bucket. */
function LineChart({ labels, lines, testId }: { labels: string[]; lines: Line[]; testId: string }) {
  const max = Math.max(1, ...lines.flatMap((l) => l.values.filter((v): v is number => v !== null)));
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const shown = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0 && i < n);
  return (
    <div data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="axis">{fmt(t)}</text>
          </g>
        ))}
        {shown.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="axis">{labels[i]}</text>
        ))}
        {lines.map((l) => {
          const pts = l.values.flatMap((v, i) => (v === null ? [] : [[x(i), y(v)] as const]));
          return (
            <g key={l.name}>
              {pts.length > 1 && <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={l.color} strokeWidth={2} />}
              {pts.length === 1 && <circle cx={pts[0][0]} cy={pts[0][1]} r={3} fill={l.color} />}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {lines.map((l) => (
          <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>
        ))}
      </div>
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
        <select aria-label="Mappa" value={conversation} onChange={(e) => setConversation(e.target.value)}>
          <option value="">Tutte le mappe</option>
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
            <Card wide title="Token nel tempo" caption="Quanto costa costruire il grafo: token scritti dal modello e restituiti dagli strumenti, per periodo e cumulati.">
              {m.tokens.series.length === 0 ? <p className="m-empty">Ancora nessuna chiamata nel periodo.</p> : (
                <div className="two-charts">
                  <div>
                    <h4>Per {m.bucket === 'hour' ? 'ora' : 'giorno'}</h4>
                    <LineChart testId="chart-tokens" labels={m.tokens.series.map((s) => label(s.t, m.bucket))} lines={[
                      { name: 'Scritti dal modello', color: 'var(--c1)', values: m.tokens.series.map((s) => s.written) },
                      { name: 'Letti dagli strumenti', color: 'var(--c2)', values: m.tokens.series.map((s) => s.read) },
                    ]} />
                  </div>
                  <div>
                    <h4>Cumulati</h4>
                    <LineChart testId="chart-tokens-cum" labels={m.tokens.series.map((s) => label(s.t, m.bucket))} lines={[
                      { name: 'Scritti dal modello', color: 'var(--c1)', values: m.tokens.series.map((s) => s.cumWritten) },
                      { name: 'Letti dagli strumenti', color: 'var(--c2)', values: m.tokens.series.map((s) => s.cumRead) },
                    ]} />
                  </div>
                </div>
              )}
            </Card>
            <Card title="Crescita del grafo" caption="Mappe, concetti, nodi e relazioni nel tempo: il grafo cresce in proporzione ai token spesi?">
              {m.growth.length === 0 ? <p className="m-empty">Ancora niente nel periodo.</p> : (
                <LineChart testId="chart-growth" labels={m.growth.map((g) => label(g.t, m.bucket))} lines={[
                  { name: 'Mappe', color: 'var(--c3)', values: m.growth.map((g) => g.maps) },
                  { name: 'Concetti', color: 'var(--c1)', values: m.growth.map((g) => g.concepts) },
                  { name: 'Nodi', color: 'var(--c2)', values: m.growth.map((g) => g.nodes) },
                  { name: 'Relazioni', color: 'var(--c4)', values: m.growth.map((g) => g.relations) },
                ]} />
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
            <Card wide title="Qualità del grafo" caption="Lacune da colmare: nodi senza testo o fonti, concetti senza superclasse, titoli simili, profondità delle mappe.">
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
                  <h4>Profondità dei nodi</h4>
                  <Bars testId="chart-depth" rows={m.quality.depth.map((n, i) => ({ name: `Livello ${i + 1}`, value: n }))} />
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
