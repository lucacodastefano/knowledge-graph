/**
 * Communities and layout of the personal graph, kept out of the React view.
 * Louvain finds the topics; each topic gets its own force layout and the topics are
 * packed side by side without overlapping, so unrelated subjects never mix.
 * Everything is seeded: the same data gives the same picture on every reload.
 */
import Graph, { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2 from 'graphology-layout-forceatlas2';

/** Community of the concepts with no link at all; laid out as a grid of its own. */
export const ISOLATED = 'isolated';

export interface Point {
  x: number;
  y: number;
}

export interface LayoutInput {
  nodes: string[];
  edges: { source: string; target: string; weight: number }[];
  /** Orders the isolated grid, so isolated concepts of the same conversation sit together. */
  sortKey?: (node: string) => string;
}

export interface LayoutOutput {
  community: Map<string, string>;
  position: Map<string, Point>;
}

/** Graph units between two linked concepts, and between two packed communities. */
const EDGE_LENGTH = 40;
const GAP = 60;

/** Small deterministic PRNG (mulberry32). */
export function seeded(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function undirected(input: LayoutInput): UndirectedGraph {
  const g = new UndirectedGraph();
  for (const n of input.nodes) g.mergeNode(n);
  for (const e of input.edges) {
    if (e.source === e.target || !g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    g.updateEdge(e.source, e.target, (a) => ({ weight: ((a.weight as number | undefined) ?? 0) + e.weight }));
  }
  return g;
}

/** Louvain communities; concepts without links all go to ISOLATED. */
export function detectCommunities(g: UndirectedGraph): Map<string, string> {
  const out = new Map<string, string>();
  const linked = new UndirectedGraph();
  g.forEachNode((n) => {
    if (g.degree(n) === 0) out.set(n, ISOLATED);
    else linked.addNode(n);
  });
  g.forEachEdge((_, a, s, t) => linked.addEdge(s, t, { weight: a.weight as number }));
  if (linked.order > 0) {
    const parts = louvain(linked, { getEdgeWeight: 'weight', rng: seeded(7) });
    for (const [n, c] of Object.entries(parts)) out.set(n, `c${c}`);
  }
  return out;
}

/** Force layout of one community around (0, 0), scaled so linked concepts sit EDGE_LENGTH apart. */
function layoutCommunity(g: UndirectedGraph, members: string[], rng: () => number): Map<string, Point> {
  const pos = new Map<string, Point>();
  if (members.length === 1) {
    pos.set(members[0], { x: 0, y: 0 });
    return pos;
  }
  const sub = new Graph({ type: 'undirected' });
  const spread = Math.sqrt(members.length) * 10;
  for (const m of members) sub.addNode(m, { x: (rng() - 0.5) * spread, y: (rng() - 0.5) * spread });
  for (const m of members) {
    g.forEachEdge(m, (_, a, s, t) => {
      if (sub.hasNode(s) && sub.hasNode(t) && !sub.hasEdge(s, t)) sub.addEdge(s, t, { weight: a.weight as number });
    });
  }
  const n = members.length;
  const iterations = n <= 30 ? 200 : n <= 300 ? 100 : 50;
  forceAtlas2.assign(sub, {
    iterations,
    getEdgeWeight: null,
    settings: { ...forceAtlas2.inferSettings(sub), barnesHutOptimize: n > 150, gravity: 1, scalingRatio: 4 },
  });
  // Normalise: median edge length -> EDGE_LENGTH, centred on the centroid.
  const lengths: number[] = [];
  sub.forEachEdge((_, __, s, t, sa, ta) => lengths.push(Math.hypot(sa.x - ta.x, sa.y - ta.y)));
  lengths.sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] || 1;
  const k = EDGE_LENGTH / median;
  let cx = 0;
  let cy = 0;
  sub.forEachNode((_, a) => {
    cx += a.x;
    cy += a.y;
  });
  cx /= n;
  cy /= n;
  sub.forEachNode((m, a) => pos.set(m, { x: (a.x - cx) * k, y: (a.y - cy) * k }));
  return pos;
}

/** Isolated concepts on a grid wider than tall, centred on (0, 0). */
function layoutGrid(members: string[]): Map<string, Point> {
  const pos = new Map<string, Point>();
  const cols = Math.max(1, Math.ceil(Math.sqrt(members.length * 2)));
  const rows = Math.ceil(members.length / cols);
  members.forEach((m, i) => {
    pos.set(m, { x: ((i % cols) - (cols - 1) / 2) * EDGE_LENGTH, y: (Math.floor(i / cols) - (rows - 1) / 2) * EDGE_LENGTH });
  });
  return pos;
}

const radiusOf = (pos: Map<string, Point>) => {
  let r = 0;
  for (const p of pos.values()) r = Math.max(r, Math.hypot(p.x, p.y));
  return r + EDGE_LENGTH / 2;
};

/**
 * Places circles of the given radii without overlap: biggest first, each one as close as
 * possible to the communities it links to (or to the centre), searching on a spiral.
 */
function pack(ids: string[], radius: Map<string, number>, links: Map<string, Map<string, number>>, rng: () => number): Map<string, Point> {
  const placed: { id: string; x: number; y: number; r: number }[] = [];
  const centre = new Map<string, Point>();
  // Communities linked to nothing spiral out from the centre: resume where the last one landed.
  let lastFree = 0;
  for (const id of ids) {
    const r = radius.get(id)!;
    let tx = 0;
    let ty = 0;
    let tw = 0;
    for (const [other, w] of links.get(id) ?? []) {
      const c = centre.get(other);
      if (!c) continue;
      tx += c.x * w;
      ty += c.y * w;
      tw += w;
    }
    if (tw > 0) {
      tx /= tw;
      ty /= tw;
    }
    const free = (x: number, y: number) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + GAP);
    const step = Math.max(GAP / 2, r / 3);
    const phase = rng() * Math.PI * 2;
    const first = tw > 0 ? 1 : Math.max(1, Math.floor((lastFree - GAP) / step));
    let spot: Point | null = tw > 0 || lastFree === 0 ? (free(tx, ty) ? { x: tx, y: ty } : null) : null;
    for (let ring = first; !spot; ring++) {
      const d = ring * step;
      const samples = Math.max(8, Math.ceil((2 * Math.PI * d) / step));
      for (let i = 0; i < samples && !spot; i++) {
        const a = phase + (i / samples) * Math.PI * 2;
        if (free(tx + d * Math.cos(a), ty + d * Math.sin(a))) spot = { x: tx + d * Math.cos(a), y: ty + d * Math.sin(a) };
      }
    }
    if (tw === 0) lastFree = Math.max(lastFree, Math.hypot(spot.x, spot.y));
    placed.push({ id, x: spot.x, y: spot.y, r });
    centre.set(id, spot);
  }
  return centre;
}

/** Full layout: communities, a force layout inside each, communities packed apart, isolated grid last. */
export function layoutPersonalGraph(input: LayoutInput): LayoutOutput {
  const rng = seeded(42);
  const g = undirected(input);
  const community = detectCommunities(g);
  const members = new Map<string, string[]>();
  for (const n of input.nodes) {
    const c = community.get(n)!;
    if (!members.has(c)) members.set(c, []);
    members.get(c)!.push(n);
  }
  const local = new Map<string, Map<string, Point>>();
  const radius = new Map<string, number>();
  for (const [c, list] of members) {
    if (c === ISOLATED) {
      const key = input.sortKey ?? ((n: string) => n);
      list.sort((a, b) => key(a).localeCompare(key(b)));
    }
    const pos = c === ISOLATED ? layoutGrid(list) : layoutCommunity(g, list, rng);
    local.set(c, pos);
    radius.set(c, radiusOf(pos));
  }
  // Links between communities pull them next to each other.
  const links = new Map<string, Map<string, number>>();
  g.forEachEdge((_, a, s, t) => {
    const cs = community.get(s)!;
    const ct = community.get(t)!;
    if (cs === ct) return;
    for (const [x, y] of [
      [cs, ct],
      [ct, cs],
    ]) {
      if (!links.has(x)) links.set(x, new Map());
      links.get(x)!.set(y, (links.get(x)!.get(y) ?? 0) + (a.weight as number));
    }
  });
  const order = [...members.keys()]
    .filter((c) => c !== ISOLATED)
    .sort((a, b) => members.get(b)!.length - members.get(a)!.length || a.localeCompare(b));
  if (members.has(ISOLATED)) order.push(ISOLATED);
  const centre = pack(order, radius, links, rng);
  const position = new Map<string, Point>();
  for (const [c, pos] of local) {
    const o = centre.get(c)!;
    for (const [n, p] of pos) position.set(n, { x: o.x + p.x, y: o.y + p.y });
  }
  return { community, position };
}

/**
 * A spot for a concept that arrived live: around its neighbour, in the direction with
 * the most free room, so the rest of the picture does not move.
 */
export function placeNear(anchor: Point, others: Iterable<Point>, rng: () => number): Point {
  const near: Point[] = [];
  for (const o of others) if (Math.abs(o.x - anchor.x) < EDGE_LENGTH * 3 && Math.abs(o.y - anchor.y) < EDGE_LENGTH * 3) near.push(o);
  let best: Point = { x: anchor.x + EDGE_LENGTH, y: anchor.y };
  let bestRoom = -1;
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < 12; i++) {
    const a = phase + (i / 12) * Math.PI * 2;
    const p = { x: anchor.x + EDGE_LENGTH * Math.cos(a), y: anchor.y + EDGE_LENGTH * Math.sin(a) };
    const room = near.reduce((m, o) => Math.min(m, Math.hypot(o.x - p.x, o.y - p.y)), Infinity);
    if (room > bestRoom) {
      bestRoom = room;
      best = p;
    }
  }
  return best;
}

/** Next free cell after the isolated grid, for an isolated concept that arrived live. */
export function nextGridSpot(isolated: Point[]): Point {
  if (isolated.length === 0) return { x: 0, y: 0 };
  const xs = isolated.map((p) => p.x);
  const ys = isolated.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const lastRow = isolated.filter((p) => p.y === maxY).map((p) => p.x);
  const nextX = Math.max(...lastRow) + EDGE_LENGTH;
  return nextX <= maxX ? { x: nextX, y: maxY } : { x: minX, y: maxY + EDGE_LENGTH };
}
