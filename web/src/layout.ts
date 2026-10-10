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
  onHover: (visitId: string | null) => void;
  onOpen: (conceptId: string) => void;
  onEdit: (visitId: string) => void;
}

/** Tree edges are solid; visits of the same concept are joined by dashed cross-links (D1). */
export function buildEdges(visits: Visit[]): Edge[] {
  const edges: Edge[] = visits
    .filter((v) => v.parentVisitId)
    .map((v) => ({ id: `t-${v.id}`, source: v.parentVisitId!, target: v.id, type: 'smoothstep' }));

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

/** Layered left-to-right layout computed on tree edges only, so cross-links never distort the tree. */
export async function layout(visits: Visit[]): Promise<Map<string, { x: number; y: number }>> {
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '22',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: visits.map((v) => ({ id: v.id, width: NODE_W, height: NODE_H })),
    edges: visits
      .filter((v) => v.parentVisitId)
      .map((v) => ({ id: v.id, sources: [v.parentVisitId!], targets: [v.id] })),
  });
  return new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

export type VisitNode = Node<VisitNodeData, 'visit'>;
