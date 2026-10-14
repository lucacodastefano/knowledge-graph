import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';
import type { Visit } from './api.ts';

const elk = new ELK();
export const NODE_W = 190;
export const NODE_H = 46;

export interface VisitNodeData extends Record<string, unknown> {
  visit: Visit;
  current: boolean;
  fresh: boolean;
  /** Visit of the concept picked in the search. */
  match: boolean;
  /** Where else this concept appears in the conversation: its other nodes, with their parents (D16). */
  also: AlsoRef[];
  /** Highlight around the hovered or selected node: the node itself, a relative of it, or neither (dimmed). */
  focus: boolean;
  related: boolean;
  dim: boolean;
  /** Under the hovered edge: faded to ~15% so the edge and its label can be read. */
  cover?: boolean;
  /** Branch toggle (view only): the node has children, its branch is folded, and how many nodes the fold hides. */
  collapsible: boolean;
  collapsed: boolean;
  /** Side of the node where its branches leave, and so where the toggle sits. */
  toggleSide?: 'left' | 'right';
  hiddenCount: number;
  onToggle: (visitId: string) => void;
  onHover: (visitId: string | null) => void;
  onOpen: (conceptId: string, conversationId?: string) => void;
  /** Select and centre another node of the conversation. */
  onGoto: (visitId: string) => void;
}

/** Another node of the same concept in the conversation, and the title of its parent ("radice" at the top). */
export interface AlsoRef {
  id: string;
  parent: string;
}

/** For each node, the other nodes of the same concept with their parents ("compare anche sotto", D16). */
export function alsoIn(visits: Visit[]): Map<string, AlsoRef[]> {
  const title = new Map(visits.map((v) => [v.id, v.title]));
  const byConcept = new Map<string, Visit[]>();
  for (const v of visits) byConcept.set(v.conceptId, [...(byConcept.get(v.conceptId) ?? []), v]);
  return new Map(
    visits.map((v) => [
      v.id,
      byConcept
        .get(v.conceptId)!
        .filter((o) => o.id !== v.id)
        .map((o) => ({ id: o.id, parent: o.parentVisitId ? title.get(o.parentVisitId) ?? '' : 'radice' })),
    ]),
  );
}

export type LayoutKind = 'radial' | 'mindmap' | 'tree';
/**
 * Where a node sits relative to its parent: to the right (tree, right half of the mind map), to the left (left
 * half of the mind map) or anywhere around it (radial). Every node has a handle on each side and on its centre,
 * always mounted, so edges switch handle by id and React Flow never holds stale handle positions.
 */
export type Side = 'right' | 'left' | 'around';
export type Half = 'right' | 'left';

export interface Placement {
  position: Map<string, { x: number; y: number }>;
  side: Map<string, Side>;
  /** Mind map: the half each first-level branch went to, fed back to the next layout so branches move only when it pays. */
  branches: Map<string, Half>;
}

const VIRTUAL_ROOT = '__root';
const treeEdges = (visits: Visit[]) =>
  visits.filter((v) => v.parentVisitId).map((v) => ({ id: v.id, sources: [v.parentVisitId!], targets: [v.id] }));
/** The invisible centre joining several roots takes almost no room. */
const box = (id: string) => (id === VIRTUAL_ROOT ? { id, width: 1, height: NODE_H } : { id, width: NODE_W, height: NODE_H });

/**
 * Beyond this many nodes the layered layout stops honouring the model's order of siblings: that option made ELK take
 * 2 s at 300 nodes and over a minute at 1,000, against under a second without it.
 */
const KEEP_ORDER_MAX = 150;

/** Layered layout of some nodes; edges only follow the tree, so cross-links never distort it. */
async function layered(visits: Visit[], direction: 'RIGHT' | 'LEFT') {
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '22',
      ...(visits.length <= KEEP_ORDER_MAX ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}),
    },
    children: visits.map((v) => box(v.id)),
    edges: treeEdges(visits),
  });
  return new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/**
 * Radial: the root topic at the centre, each level on a wider ring; several roots sit on the first ring around an
 * empty centre. Every subtree gets a wedge as wide as its share of leaves, so branches never cross; each ring is
 * pushed out until none of its nodes overlaps a node already placed, since the nodes are much wider than tall.
 */
function radial(visits: Visit[]) {
  const children = new Map<string | null, Visit[]>();
  for (const v of visits) children.set(v.parentVisitId, [...(children.get(v.parentVisitId) ?? []), v]);
  const leaves = new Map<string, number>();
  const countLeaves = (v: Visit): number => {
    const cs = children.get(v.id) ?? [];
    const n = cs.length ? cs.reduce((a, c) => a + countLeaves(c), 0) : 1;
    leaves.set(v.id, n);
    return n;
  };
  const roots = children.get(null) ?? [];
  roots.forEach(countLeaves);

  // Angles: each node in the middle of its wedge, the first branch at the top right, clockwise.
  const angle = new Map<string, number>();
  const rings: Visit[][] = [];
  const spread = (vs: Visit[], from: number, width: number, depth: number) => {
    const total = vs.reduce((a, v) => a + leaves.get(v.id)!, 0);
    let a0 = from;
    for (const v of vs) {
      const w = (width * leaves.get(v.id)!) / total;
      angle.set(v.id, a0 + w / 2);
      (rings[depth] ??= []).push(v);
      spread(children.get(v.id) ?? [], a0, w, depth + 1);
      a0 += w;
    }
  };
  const single = roots.length === 1;
  if (single) {
    rings[0] = [roots[0]];
    spread(children.get(roots[0].id) ?? [], -Math.PI / 2, 2 * Math.PI, 1);
  } else spread(roots, -Math.PI / 2, 2 * Math.PI, 1);

  const gap = 24;
  const placed: { x: number; y: number }[] = [];
  const position = new Map<string, { x: number; y: number }>();
  const at = (v: Visit, r: number) => ({ x: r * Math.cos(angle.get(v.id)!) - NODE_W / 2, y: r * Math.sin(angle.get(v.id)!) - NODE_H / 2 });
  const clash = (p: { x: number; y: number }, others: { x: number; y: number }[]) =>
    others.some((q) => Math.abs(p.x - q.x) < NODE_W + gap && Math.abs(p.y - q.y) < NODE_H + gap);
  let radius = 0;
  rings.forEach((ring, depth) => {
    if (!ring?.length) return;
    if (depth === 0) {
      const p = { x: -NODE_W / 2, y: -NODE_H / 2 };
      position.set(ring[0].id, p);
      placed.push(p);
      return;
    }
    radius += depth === 1 ? 150 : 110;
    for (;;) {
      const ps: { x: number; y: number }[] = [];
      const ok = ring.every((v) => {
        const p = at(v, radius);
        if (clash(p, placed) || clash(p, ps)) return false;
        ps.push(p);
        return true;
      });
      if (ok) {
        ring.forEach((v, i) => position.set(v.id, ps[i]));
        placed.push(...ps);
        return;
      }
      radius += 10;
    }
  });
  return position;
}

/**
 * Splits the first-level branches between the two halves of the mind map. A branch is as tall as its leaves, so
 * the halves are balanced by leaves, not by node count; moving a branch that was already placed costs one leaf,
 * so a growing map keeps its shape unless the balance clearly improves. Ties keep the earlier branches on the right.
 */
export function splitBranches(weights: number[], previous: (Half | undefined)[] = []): Half[] {
  const n = weights.length;
  if (n > 14) {
    // Too many branches to try every split: greedy, in order, onto the lighter half.
    let r = 0;
    let l = 0;
    return weights.map((w) => (r <= l ? ((r += w), 'right') : ((l += w), 'left')));
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let best: Half[] = [];
  let bestCost = Infinity;
  // Bit i set = branch i on the right. Counting down from all-right with the first branch fixed on the right,
  // earlier branches stay on the right longest, so the first split found wins ties.
  for (let mask = (1 << n) - 1; mask >= (n ? 1 << (n - 1) : 0); mask--) {
    let right = 0;
    let moved = 0;
    const sides = weights.map((w, i): Half => {
      const s = (mask >> (n - 1 - i)) & 1 ? 'right' : 'left';
      if (s === 'right') right += w;
      if (previous[i] && previous[i] !== s) moved++;
      return s;
    });
    const cost = Math.abs(total - 2 * right) + moved;
    if (cost < bestCost) [best, bestCost] = [sides, cost];
  }
  return best;
}

/** Mind map: the root topic in the middle, its branches split between the right and the left halves. */
async function mindmap(visits: Visit[], previous: Map<string, Half>): Promise<Placement> {
  const roots = visits.filter((v) => !v.parentVisitId);
  const children = new Map<string, Visit[]>();
  for (const v of visits) if (v.parentVisitId) children.set(v.parentVisitId, [...(children.get(v.parentVisitId) ?? []), v]);
  const subtree = (v: Visit): Visit[] => [v, ...(children.get(v.id) ?? []).flatMap(subtree)];
  const leaves = (v: Visit): number => {
    const cs = children.get(v.id) ?? [];
    return cs.length ? cs.reduce((a, c) => a + leaves(c), 0) : 1;
  };

  // With several roots they are the branches, around an invisible centre.
  const centre: Visit | null = roots.length === 1 ? roots[0] : null;
  const firstLevel = centre ? (children.get(centre.id) ?? []) : roots;
  const split = splitBranches(firstLevel.map(leaves), firstLevel.map((b) => previous.get(b.id)));
  const branches = new Map(firstLevel.map((b, i) => [b.id, split[i]]));
  const right = firstLevel.filter((b) => branches.get(b.id) === 'right').flatMap(subtree);
  const left = firstLevel.filter((b) => branches.get(b.id) === 'left').flatMap(subtree);

  const hub: Visit = centre ?? { ...roots[0], id: VIRTUAL_ROOT };
  const attach = (vs: Visit[]) => vs.map((v) => (v.parentVisitId ? v : { ...v, parentVisitId: VIRTUAL_ROOT }));
  const rightPos = await layered([hub, ...attach(right)], 'RIGHT');
  const leftPos = await layered([hub, ...attach(left)], 'LEFT');
  const a = rightPos.get(hub.id)!;
  const b = leftPos.get(hub.id)!;
  const position = new Map(rightPos);
  for (const [id, p] of leftPos) if (id !== hub.id) position.set(id, { x: p.x + a.x - b.x, y: p.y + a.y - b.y });
  position.delete(VIRTUAL_ROOT);
  const side = new Map<string, Side>(visits.map((v) => [v.id, 'right']));
  for (const v of left) side.set(v.id, 'left');
  return { position, side, branches };
}

export async function layout(visits: Visit[], kind: LayoutKind = 'radial', previous: Map<string, Half> = new Map()): Promise<Placement> {
  if (kind === 'mindmap') return mindmap(visits, previous);
  const position = kind === 'radial' ? radial(visits) : await layered(visits, 'RIGHT');
  return { position, side: new Map(visits.map((v) => [v.id, kind === 'radial' ? 'around' : 'right'])), branches: new Map() };
}

/** Every node carries a source (`s-`) and a target (`t-`) handle on each of these. */
export const HANDLES = ['left', 'right', 'center'] as const;

export interface EdgeData extends Record<string, unknown> {
  /** Cross-links (D1): the concept they join and their precomputed route. */
  concept?: string;
  path?: string;
}

/**
 * Tree edges are solid and leave the parent on the side facing the child; visits of the same concept are joined by
 * dashed cross-links (D1), routed around the other nodes when one of a few simple curves can do it.
 */
export function buildEdges(visits: Visit[], kind: LayoutKind, placement: Placement): Edge<EdgeData>[] {
  const type = kind === 'radial' ? 'straight' : kind === 'mindmap' ? 'default' : 'smoothstep';
  const edges: Edge<EdgeData>[] = visits
    .filter((v) => v.parentVisitId && placement.position.has(v.parentVisitId))
    .map((v) => {
      const side = placement.side.get(v.id) ?? 'right';
      const [from, to] = side === 'around' ? ['center', 'center'] : side === 'left' ? ['left', 'right'] : ['right', 'left'];
      return { id: `t-${v.id}`, source: v.parentVisitId!, target: v.id, sourceHandle: `s-${from}`, targetHandle: `t-${to}`, type };
    });

  const rects = new Map([...placement.position].map(([id, p]) => [id, { ...p, w: NODE_W, h: NODE_H }]));
  const lastByConcept = new Map<string, Visit>();
  for (const v of visits) {
    const prev = lastByConcept.get(v.conceptId);
    const a = prev && rects.get(prev.id);
    const b = rects.get(v.id);
    if (prev && a && b) {
      const others = [...rects.values()].filter((r) => r !== a && r !== b);
      edges.push({
        id: `x-${prev.id}-${v.id}`,
        source: prev.id,
        target: v.id,
        sourceHandle: 's-center',
        targetHandle: 't-center',
        type: 'cross',
        className: 'cross-link',
        data: { concept: v.conceptId, path: route(a, b, others, kind) },
      });
    }
    lastByConcept.set(v.conceptId, v);
  }
  return edges;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Pt = { x: number; y: number };
type Curve = [Pt, Pt, Pt, Pt];

const at = (c: Curve, t: number): Pt => {
  const u = 1 - t;
  const [a, b, d, e] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
};

/** How bad a curve is: every node it runs under costs far more than its length. */
function cost(c: Curve, others: Rect[]): number {
  const pts = Array.from({ length: 49 }, (_, i) => at(c, i / 48));
  const pad = 6;
  const crossed = others.filter((r) =>
    pts.some((p) => p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad),
  ).length;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return crossed * 10_000 + length;
}

const CELL = 6;
const MARGIN = 6;
const NEAR = 12;
const TURN = 8;
/** Beyond this many grid cells a cross-link falls back to the cheapest simple curve. */
const MAX_CELLS = 250_000;
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

/**
 * Orthogonal route between two nodes of a column layout that runs under no other node: a shortest path on a
 * grid, from a side of one node to a side of the other, with a cost per bend so it keeps to few straight runs.
 * Returns the corner points, or null when there is no such path within the searched window.
 */
function gridRoute(a: Rect, b: Rect, all: Rect[]): Pt[] | null {
  const reach = 260;
  const x0 = Math.min(a.x, b.x) - reach;
  const y0 = Math.min(a.y, b.y) - reach;
  const cols = Math.ceil((Math.max(a.x + a.w, b.x + b.w) + reach - x0) / CELL) + 1;
  const rows = Math.ceil((Math.max(a.y + a.h, b.y + b.h) + reach - y0) / CELL) + 1;
  if (cols * rows > MAX_CELLS) return null;
  // 2 = under a node (with a margin), 1 = close to one: allowed, but a wider corridor is preferred.
  const blocked = new Uint8Array(cols * rows);
  const mark = (r: Rect, m: number, value: number) => {
    const i0 = Math.max(0, Math.ceil((r.x - m - x0) / CELL));
    const i1 = Math.min(cols - 1, Math.floor((r.x + r.w + m - x0) / CELL));
    const j0 = Math.max(0, Math.ceil((r.y - m - y0) / CELL));
    const j1 = Math.min(rows - 1, Math.floor((r.y + r.h + m - y0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * cols + i] = Math.max(blocked[j * cols + i], value);
  };
  for (const r of all) mark(r, MARGIN + NEAR, 1);
  for (const r of all) mark(r, MARGIN, 2);
  // A port just outside each side of a node; leaving `a` heads away from it, reaching `b` heads into it.
  const port = (r: Rect, right: boolean) => ({
    i: Math.round(((right ? r.x + r.w + MARGIN + CELL : r.x - MARGIN - CELL) - x0) / CELL),
    j: Math.round((r.y + r.h / 2 - y0) / CELL),
    dir: right ? 0 : 1,
  });
  const starts = [port(a, true), port(a, false)];
  // Reaching b's left port means moving right (0), its right port moving left (1).
  const goals = [{ ...port(b, false), dir: 0 }, { ...port(b, true), dir: 1 }];
  const h = (i: number, j: number) => Math.min(...goals.map((g) => Math.abs(g.i - i) + Math.abs(g.j - j)));

  const n = cols * rows * 4;
  const cost = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  // Binary heap of [f, state]; state -1 - k marks reaching goal k.
  const heap: [number, number][] = [];
  const push = (f: number, s: number) => {
    heap.push([f, s]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows && blocked[j * cols + i] < 2;
  for (const s of starts) {
    if (!inside(s.i, s.j)) continue;
    const st = (s.j * cols + s.i) * 4 + s.dir;
    cost[st] = 0;
    push(h(s.i, s.j), st);
  }
  const doneCost = goals.map(() => Infinity);
  const doneFrom = goals.map(() => -1);
  while (heap.length) {
    const [, st] = pop();
    if (st < 0) {
      // A goal: walk back to the start.
      const k = -1 - st;
      const cells: Pt[] = [];
      for (let s = doneFrom[k]; s >= 0; s = prev[s]) {
        const c = s >> 2;
        cells.push({ x: x0 + (c % cols) * CELL, y: y0 + Math.floor(c / cols) * CELL });
      }
      cells.reverse();
      const first = cells[0];
      const last = cells[cells.length - 1];
      const fromRight = first.x > a.x + a.w / 2;
      const intoLeft = last.x < b.x + b.w / 2;
      const pts = [{ x: fromRight ? a.x + a.w : a.x, y: first.y }, ...cells, { x: intoLeft ? b.x : b.x + b.w, y: last.y }];
      // Keep only the corners.
      return pts.filter((p, i) => {
        if (i === 0 || i === pts.length - 1) return true;
        const [q, r] = [pts[i - 1], pts[i + 1]];
        return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) !== 0;
      });
    }
    const g = cost[st];
    const c = st >> 2;
    const dir = st & 3;
    const i = c % cols;
    const j = Math.floor(c / cols);
    goals.forEach((goal, k) => {
      if (goal.i !== i || goal.j !== j) return;
      const total = g + (dir === goal.dir ? 0 : TURN);
      if (total < doneCost[k]) {
        doneCost[k] = total;
        doneFrom[k] = st;
        push(total, -1 - k);
      }
    });
    for (let d = 0; d < 4; d++) {
      if ((d ^ 1) === dir) continue; // no U-turns
      const ni = i + DX[d];
      const nj = j + DY[d];
      if (!inside(ni, nj)) continue;
      const ns = (nj * cols + ni) * 4 + d;
      const ng = g + 1 + blocked[nj * cols + ni] + (d === dir ? 0 : TURN);
      if (ng < cost[ns]) {
        cost[ns] = ng;
        prev[ns] = st;
        push(ng + h(ni, nj), ns);
      }
    }
  }
  return null;
}

/** A polyline with rounded corners, as an SVG path. */
function rounded(pts: Pt[], radius = 14): string {
  const f = (p: Pt) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
  let d = `M${f(pts[0])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, q, r] = [pts[i - 1], pts[i], pts[i + 1]];
    const l1 = Math.hypot(q.x - p.x, q.y - p.y);
    const l2 = Math.hypot(r.x - q.x, r.y - q.y);
    const k1 = Math.min(radius, l1 / 2) / l1;
    const k2 = Math.min(radius, l2 / 2) / l2;
    d += ` L${f({ x: q.x - (q.x - p.x) * k1, y: q.y - (q.y - p.y) * k1 })} Q${f(q)} ${f({ x: q.x + (r.x - q.x) * k2, y: q.y + (r.y - q.y) * k2 })}`;
  }
  return `${d} L${f(pts[pts.length - 1])}`;
}

/** The cheapest of a few candidate curves between two nodes, as an SVG path. */
function route(a: Rect, b: Rect, others: Rect[], kind: LayoutKind): string {
  const mid = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const [ca, cb] = [mid(a), mid(b)];
  const candidates: Curve[] = [];
  if (kind === 'radial') {
    // From centre to centre (the ends hide under the nodes), straight or bowed to either side.
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
    const n = { x: -(cb.y - ca.y) / len, y: (cb.x - ca.x) / len };
    for (const k of [0, 0.2, -0.2, 0.4, -0.4]) {
      const p = (t: number) => ({ x: ca.x + (cb.x - ca.x) * t + n.x * k * len, y: ca.y + (cb.y - ca.y) * t + n.y * k * len });
      candidates.push([ca, p(1 / 3), p(2 / 3), cb]);
    }
    // When every gentle curve runs under some node, go around them on the grid.
    if (candidates.every((c) => cost(c, others) >= 10_000)) {
      const grid = gridRoute(a, b, [a, b, ...others]);
      if (grid) return rounded(grid);
    }
  } else {
    const grid = gridRoute(a, b, [a, b, ...others]);
    if (grid) return rounded(grid);
    const L = (r: Rect) => ({ x: r.x, y: r.y + r.h / 2 });
    const R = (r: Rect) => ({ x: r.x + r.w, y: r.y + r.h / 2 });
    const T = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y });
    const B = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h });
    const dx = Math.abs(cb.x - ca.x);
    const dy = Math.abs(cb.y - ca.y);
    // Facing sides, like a tree edge.
    const k = Math.max(40, dx / 2);
    if (cb.x >= ca.x) candidates.push([R(a), { x: R(a).x + k, y: R(a).y }, { x: L(b).x - k, y: L(b).y }, L(b)]);
    else candidates.push([L(a), { x: L(a).x - k, y: L(a).y }, { x: R(b).x + k, y: R(b).y }, R(b)]);
    // Loops out of the same side, into the gap between columns.
    for (const bulge of [35, 50]) {
      const right = Math.max(a.x + a.w, b.x + b.w) + bulge;
      const left = Math.min(a.x, b.x) - bulge;
      candidates.push([R(a), { x: right, y: R(a).y }, { x: right, y: R(b).y }, R(b)]);
      candidates.push([L(a), { x: left, y: L(a).y }, { x: left, y: L(b).y }, L(b)]);
    }
    // Arcs over the top or under the bottom.
    const arc = 30 + Math.min(120, dx * 0.15 + dy * 0.1);
    const top = Math.min(a.y, b.y) - arc;
    const bottom = Math.max(a.y + a.h, b.y + b.h) + arc;
    candidates.push([T(a), { x: T(a).x, y: top }, { x: T(b).x, y: top }, T(b)]);
    candidates.push([B(a), { x: B(a).x, y: bottom }, { x: B(b).x, y: bottom }, B(b)]);
  }
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const k = cost(c, others);
    if (k < bestCost) [best, bestCost] = [c, k];
  }
  const f = (p: Pt) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
  return `M${f(best[0])} C${f(best[1])} ${f(best[2])} ${f(best[3])}`;
}

/**
 * What is highlighted around a node (hover or selection): its parent, its children and the other nodes of the
 * same concept, with the edges joining the node to them and the cross-links of its concept.
 */
export function neighbourhood(visits: Visit[], focusId: string): { nodes: Set<string>; edges: Set<string> } | null {
  const focus = visits.find((v) => v.id === focusId);
  if (!focus) return null;
  const nodes = new Set([focus.id]);
  const edges = new Set<string>();
  if (focus.parentVisitId) {
    nodes.add(focus.parentVisitId);
    edges.add(`t-${focus.id}`);
  }
  let prev: Visit | undefined;
  for (const v of visits) {
    if (v.parentVisitId === focus.id) {
      nodes.add(v.id);
      edges.add(`t-${v.id}`);
    }
    if (v.conceptId === focus.conceptId) {
      nodes.add(v.id);
      if (prev) edges.add(`x-${prev.id}-${v.id}`);
      prev = v;
    }
  }
  return { nodes, edges };
}

export type VisitNode = Node<VisitNodeData, 'visit'>;
