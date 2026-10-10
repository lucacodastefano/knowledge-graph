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
  hovered: boolean;
  /** Visit of the concept picked in the search. */
  match: boolean;
  /** Where else this concept appears in the conversation: the parents of its other nodes (D16). */
  also: string[];
  handles: Handles;
  onHover: (visitId: string | null) => void;
  onOpen: (conceptId: string) => void;
}

/** Tree edges are solid; visits of the same concept are joined by dashed cross-links (D1). */
export function buildEdges(visits: Visit[], kind: LayoutKind = 'radial'): Edge[] {
  const edgeType = kind === 'radial' ? 'straight' : kind === 'mindmap' ? 'default' : 'smoothstep';
  const edges: Edge[] = visits
    .filter((v) => v.parentVisitId)
    .map((v) => ({ id: `t-${v.id}`, source: v.parentVisitId!, target: v.id, type: edgeType }));

  const lastByConcept = new Map<string, Visit>();
  for (const v of visits) {
    const prev = lastByConcept.get(v.conceptId);
    if (prev) {
      edges.push({ id: `x-${prev.id}-${v.id}`, source: prev.id, target: v.id, className: 'cross-link', animated: false });
    }
    lastByConcept.set(v.conceptId, v);
  }
  return edges;
}

/** For each node, the parents of the other nodes of the same concept ("anche in", D16). */
export function alsoIn(visits: Visit[]): Map<string, string[]> {
  const title = new Map(visits.map((v) => [v.id, v.title]));
  const byConcept = new Map<string, Visit[]>();
  for (const v of visits) byConcept.set(v.conceptId, [...(byConcept.get(v.conceptId) ?? []), v]);
  return new Map(
    visits.map((v) => [
      v.id,
      byConcept
        .get(v.conceptId)!
        .filter((o) => o.id !== v.id)
        .map((o) => (o.parentVisitId ? title.get(o.parentVisitId) ?? '' : 'radice')),
    ]),
  );
}

export type LayoutKind = 'radial' | 'mindmap' | 'tree';
/** Where a node's edges attach: tree and right side of the mind map left-to-right, left side mirrored, radial at the centre. */
export type Handles = 'lr' | 'rl' | 'center';

export interface Placement {
  position: Map<string, { x: number; y: number }>;
  handles: Map<string, Handles>;
}

const VIRTUAL_ROOT = '__root';
const treeEdges = (visits: Visit[]) =>
  visits.filter((v) => v.parentVisitId).map((v) => ({ id: v.id, sources: [v.parentVisitId!], targets: [v.id] }));
/** The invisible centre joining several roots takes almost no room. */
const box = (id: string) => (id === VIRTUAL_ROOT ? { id, width: 1, height: NODE_H } : { id, width: NODE_W, height: NODE_H });

/** Layered layout of some nodes; edges only follow the tree, so cross-links never distort it. */
async function layered(visits: Visit[], direction: 'RIGHT' | 'LEFT') {
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '22',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: visits.map((v) => box(v.id)),
    edges: treeEdges(visits),
  });
  return new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/** Radial: the root topic at the centre, each level on a wider ring. Several roots hang from an invisible centre. */
async function radial(visits: Visit[]) {
  const roots = visits.filter((v) => !v.parentVisitId);
  const edges = treeEdges(visits);
  const children = visits.map((v) => box(v.id));
  if (roots.length > 1) {
    children.unshift(box(VIRTUAL_ROOT));
    edges.push(...roots.map((r) => ({ id: `v-${r.id}`, sources: [VIRTUAL_ROOT], targets: [r.id] })));
  }
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'radial',
      'elk.spacing.nodeNode': '30',
      'elk.radial.compactor': 'WEDGE_COMPACTION',
      'elk.radial.compactionStepSize': '1',
    },
    children,
    edges,
  });
  return new Map((graph.children ?? []).filter((c) => c.id !== VIRTUAL_ROOT).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/** Mind map: the root topic in the middle, its branches split between the right and the left by size. */
async function mindmap(visits: Visit[]): Promise<Placement> {
  const roots = visits.filter((v) => !v.parentVisitId);
  const children = new Map<string, Visit[]>();
  for (const v of visits) if (v.parentVisitId) children.set(v.parentVisitId, [...(children.get(v.parentVisitId) ?? []), v]);
  const subtree = (v: Visit): Visit[] => [v, ...(children.get(v.id) ?? []).flatMap(subtree)];

  // With several roots they are the branches, around an invisible centre.
  const centre: Visit | null = roots.length === 1 ? roots[0] : null;
  const branches = centre ? (children.get(centre.id) ?? []) : roots;
  const right: Visit[] = [];
  const left: Visit[] = [];
  let r = 0;
  let l = 0;
  for (const b of branches) {
    const nodes = subtree(b);
    if (r <= l) (right.push(...nodes), (r += nodes.length));
    else (left.push(...nodes), (l += nodes.length));
  }
  const hub: Visit = centre ?? { ...roots[0], id: VIRTUAL_ROOT };
  const attach = (vs: Visit[]) => vs.map((v) => (v.parentVisitId ? v : { ...v, parentVisitId: VIRTUAL_ROOT }));
  const rightPos = await layered([hub, ...attach(right)], 'RIGHT');
  const leftPos = await layered([hub, ...attach(left)], 'LEFT');
  const a = rightPos.get(hub.id)!;
  const b = leftPos.get(hub.id)!;
  const position = new Map(rightPos);
  for (const [id, p] of leftPos) if (id !== hub.id) position.set(id, { x: p.x + a.x - b.x, y: p.y + a.y - b.y });
  position.delete(VIRTUAL_ROOT);
  const handles = new Map<string, Handles>(visits.map((v) => [v.id, 'lr']));
  for (const v of left) handles.set(v.id, 'rl');
  return { position, handles };
}

export async function layout(visits: Visit[], kind: LayoutKind = 'radial'): Promise<Placement> {
  if (kind === 'mindmap') return mindmap(visits);
  const position = kind === 'radial' ? await radial(visits) : await layered(visits, 'RIGHT');
  return { position, handles: new Map(visits.map((v) => [v.id, kind === 'radial' ? 'center' : 'lr'])) };
}

export type VisitNode = Node<VisitNodeData, 'visit'>;
