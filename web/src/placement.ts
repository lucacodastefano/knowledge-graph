/**
 * Where a node that has no place yet goes, without touching any node that has one. A new node sits next to its
 * parent on the side the branch grows towards, in the nearest spot that overlaps nothing.
 */
export interface Pos {
  x: number;
  y: number;
}

export interface PlaceInput {
  visits: { id: string; parentVisitId: string | null }[];
  /** Nodes that already have a place (hidden ones included): they never move and are never overlapped. */
  fixed: Map<string, Pos>;
  /** Nodes to place. */
  todo: string[];
  /** A place tried first, for nodes the automatic layout already positioned. */
  preferred?: Map<string, Pos>;
  kind: 'radial' | 'mindmap' | 'tree';
  /** Size of a node. */
  w: number;
  h: number;
}

const GAP = 16;
const COLUMN_GAP = 70;
const STEP = Math.PI / 9;

/** Top-left corners of the todo nodes. */
export function placeNew({ visits, fixed, todo, preferred, kind, w, h }: PlaceInput): Map<string, Pos> {
  const parentOf = new Map(visits.map((v) => [v.id, v.parentVisitId]));
  const spot = new Map(fixed);
  const result = new Map<string, Pos>();
  const occupied: Pos[] = [...fixed.values()];
  const free = (p: Pos) => !occupied.some((q) => Math.abs(p.x - q.x) < w + GAP && Math.abs(p.y - q.y) < h + GAP);
  const accept = (id: string, p: Pos) => {
    spot.set(id, p);
    result.set(id, p);
    occupied.push(p);
  };

  // Parents before their children, so a child finds its parent placed.
  const pending = new Set(todo);
  const depth = (id: string): number => {
    let d = 0;
    for (let p = parentOf.get(id); p && pending.has(p); p = parentOf.get(p)) d++;
    return d;
  };
  const ordered = [...todo].sort((a, b) => depth(a) - depth(b));

  for (const id of ordered) {
    const want = preferred?.get(id);
    if (want && free(want)) {
      accept(id, want);
      continue;
    }
    const parent = parentOf.get(id);
    const at = parent ? spot.get(parent) : undefined;
    accept(id, (at ? near(at, parent!) : apart()) ?? want ?? { x: 0, y: 0 });
  }
  return result;

  /** Nearest free spot around a parent, growing the way its own branch grows. */
  function near(p: Pos, parentId: string): Pos | undefined {
    const grand = parentOf.get(parentId);
    const g = grand ? spot.get(grand) : undefined;
    if (kind === 'radial') {
      const c = centroid();
      const dx = p.x - (g ?? c).x;
      const dy = p.y - (g ?? c).y;
      const base = Math.hypot(dx, dy) < 1 ? 0 : Math.atan2(dy, dx);
      // The way out first; going back towards the parent only when nothing else is free.
      for (const reach of [Math.PI * 0.55, Math.PI]) {
        for (let r = 150; r <= 150 + 40 * 30; r += 40) {
          for (let k = 0; k * STEP <= reach; k++) {
            for (const sign of k === 0 ? [1] : [1, -1]) {
              const a = base + sign * k * STEP;
              const q = { x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) };
              if (free(q)) return q;
            }
          }
        }
      }
      return undefined;
    }
    let dir = 1;
    if (kind === 'mindmap') {
      if (g) dir = p.x < g.x ? -1 : 1;
      else {
        // The centre: the half with fewer children takes the next one.
        const kids = visits.filter((v) => v.parentVisitId === parentId && spot.has(v.id)).map((v) => spot.get(v.id)!);
        dir = kids.filter((q) => q.x < p.x).length < kids.filter((q) => q.x >= p.x).length ? -1 : 1;
      }
    }
    for (let col = 0; col < 12; col++) {
      const x = p.x + dir * (w + COLUMN_GAP) * (col + 1);
      for (let k = 0; k < 120; k++) {
        const y = p.y + Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (h + 22);
        if (free({ x, y })) return { x, y };
      }
    }
    return undefined;
  }

  /** A node without a parent goes right of everything, from the top. */
  function apart(): Pos | undefined {
    if (!occupied.length) return { x: 0, y: 0 };
    const x = Math.max(...occupied.map((q) => q.x)) + w + 80;
    const y0 = Math.min(...occupied.map((q) => q.y));
    for (let k = 0; k < 2000; k++) {
      const q = { x, y: y0 + k * (h + 22) };
      if (free(q)) return q;
    }
    return undefined;
  }

  function centroid(): Pos {
    const pts = [...fixed.values()];
    if (!pts.length) return { x: 0, y: 0 };
    return { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
  }
}
