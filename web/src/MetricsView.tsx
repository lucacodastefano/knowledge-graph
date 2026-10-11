import { useEffect, useMemo, useState } from 'react';
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


interface SunNode {
  id: string;
  name: string;
  children: SunNode[];
  /** Nodes below this one, itself excluded. */
  below: number;
  depth: number;
  parent: SunNode | null;
  branch: number;
}

/** Root = the chosen graph, or "all graphs" with one sector per graph; then the node trees. */
function buildSun(q: Metrics['quality'], multi: boolean): SunNode {
  const make = (id: string, name: string, parent: SunNode | null, branch: number): SunNode => ({ id, name, children: [], below: 0, depth: parent ? parent.depth + 1 : 0, parent, branch });
  const kids = new Map<string, typeof q.tree>();
  for (const n of q.tree) kids.set(n.parent ?? `g:${n.graph}`, [...(kids.get(n.parent ?? `g:${n.graph}`) ?? []), n]);
  const grow = (node: SunNode, key: string, branchOf: (i: number) => number) => {
    (kids.get(key) ?? []).forEach((k, i) => {
      const c = make(k.id, k.title, node, branchOf(i));
      node.children.push(c);
      grow(c, k.id, () => c.branch);
    });
    node.below = node.children.reduce((a, c) => a + 1 + c.below, 0);
  };
  if (multi) {
    const root = make('root', 'Tutti i grafi', null, 0);
    q.graphs.forEach((g, i) => {
      const gn = make(`g:${g.id}`, g.title, root, i);
      root.children.push(gn);
      grow(gn, `g:${g.id}`, () => i);
    });
    root.below = root.children.reduce((a, c) => a + 1 + c.below, 0);
    return root;
  }
  const g = q.graphs[0];
  const root = make('root', g?.title ?? 'Grafo', null, 0);
  grow(root, `g:${g?.id}`, (i) => i);
  return root;
}

const RINGS = 6;
const SUN = 300;

/** Dependency-free sunburst: ring = depth, arc width = size of the subtree, colour = first-level branch. Click an arc to zoom in, the centre to go up. */
function Sunburst({ quality, multi }: { quality: Metrics['quality']; multi: boolean }) {
  const root = useMemo(() => buildSun(quality, multi), [quality, multi]);
  const [focusId, setFocusId] = useState('root');
  const [hover, setHover] = useState<SunNode | null>(null);
  const index = useMemo(() => {
    const m = new Map<string, SunNode>();
    const walk = (n: SunNode) => (m.set(n.id, n), n.children.forEach(walk));
    walk(root);
    return m;
  }, [root]);
  const focus = index.get(focusId) ?? root;
  if (root.below === 0) return <p className="m-empty">Ancora nessun nodo.</p>;
  const r = (SUN / 2 - 4) / (RINGS + 1);
  const arcs: { n: SunNode; a0: number; a1: number; ring: number }[] = [];
  const lay = (n: SunNode, a0: number, a1: number, ring: number) => {
    let a = a0;
    for (const c of n.children) {
      const share = ((1 + c.below) / Math.max(1, n.below)) * (a1 - a0);
      if (ring <= RINGS && share > 0.012) {
        arcs.push({ n: c, a0: a, a1: a + share, ring });
        lay(c, a, a + share, ring + 1);
      }
      a += share;
    }
  };
  lay(focus, 0, Math.PI * 2, 1);
  const pt = (rad: number, a: number) => [Math.sin(a) * rad, -Math.cos(a) * rad];
  const path = ({ a0, a1, ring }: { a0: number; a1: number; ring: number }) => {
    const [r0, r1] = [ring * r, (ring + 1) * r - 1];
    const full = a1 - a0 > Math.PI * 2 - 0.001 ? a1 - 0.001 : a1;
    const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, full), [x2, y2] = pt(r0, full), [x3, y3] = pt(r0, a0);
    const big = full - a0 > Math.PI ? 1 : 0;
    return `M${x0},${y0}A${r1},${r1} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${big} 0 ${x3},${y3}Z`;
  };
  const shown = hover ?? focus;
  return (
    <div className="sunburst" data-testid="chart-depth">
      <svg viewBox={`${-SUN / 2} ${-SUN / 2} ${SUN} ${SUN}`} role="img" aria-label="Albero dei nodi">
        {arcs.map(({ n, a0, a1, ring }) => (
          <path
            key={n.id}
            d={path({ a0, a1, ring })}
            fill={`hsl(${(n.branch * 47) % 360} 55% ${62 - ring * 4}%)`}
            className="arc"
            data-arc={n.name}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(null)}
            onClick={() => n.children.length && setFocusId(n.id)}
          >
            <title>{`${n.name} · ${n.below} sotto`}</title>
          </path>
        ))}
        <circle r={r - 1} className="sun-centre" onClick={() => focus.parent && setFocusId(focus.parent.id)} style={{ cursor: focus.parent ? 'pointer' : 'default' }} />
        <text className="sun-label" textAnchor="middle" y={-4}>{shown.name.length > 18 ? `${shown.name.slice(0, 17)}…` : shown.name}</text>
        <text className="sun-sub" textAnchor="middle" y={10}>{shown.below} sotto{focus.parent && !hover ? ' · ↩' : ''}</text>
      </svg>
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
                  <h4>Forma dell’albero</h4>
                  <p className="caption">Al centro la radice, un anello per livello, un arco per nodo grande quanto i suoi discendenti, colorato per ramo. Clic su un arco per entrare, sul centro per risalire: mostra profondità, equilibrio e ramificazione insieme.</p>
                  <Sunburst key={conversation} quality={m.quality} multi={!conversation} />
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
