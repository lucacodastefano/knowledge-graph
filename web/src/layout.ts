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
