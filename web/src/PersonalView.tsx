import { useEffect, useRef, useState } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Sigma from 'sigma';
import { api, type PersonalGraph } from './api.ts';
import type { LiveEvent } from './App.tsx';

interface Props {
  live: LiveEvent | null;
  onOpenConcept: (conceptId: string) => void;
}

interface NodeAttrs {
  label: string;
  summary: string;
  visitCount: number;
  lastSeenAt: string;
  x: number;
  y: number;
  size: number;
  color: string;
}

interface Hover {
  id: string;
  x: number;
  y: number;
}

const RECENT_MS = 24 * 3600 * 1000;
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const nodeSize = (visits: number) => 4 + 3 * Math.sqrt(visits);

/**
 * Merges the server graph into the graphology instance, keeping the positions of
 * known concepts so the picture does not jump; new concepts start next to a neighbour.
 */
function merge(graph: Graph<NodeAttrs>, data: PersonalGraph, colors: { node: string; recent: string }): number {
  const now = Date.now();
  const seen = new Set<string>();
  let added = 0;
  for (const c of data.concepts) {
    seen.add(c.id);
    const attrs = {
      label: c.name,
      summary: c.summary,
      visitCount: c.visitCount,
      lastSeenAt: c.lastSeenAt,
      size: nodeSize(c.visitCount),
      color: now - Date.parse(c.lastSeenAt) < RECENT_MS ? colors.recent : colors.node,
    };
    if (graph.hasNode(c.id)) graph.mergeNodeAttributes(c.id, attrs);
    else {
      const neighbour = data.edges.find((e) => e.target === c.id && graph.hasNode(e.source))?.source;
      const base = neighbour ? graph.getNodeAttributes(neighbour) : { x: 0, y: 0 };
      graph.addNode(c.id, { ...attrs, x: base.x + Math.random() * 10 - 5, y: base.y + Math.random() * 10 - 5 });
      added++;
    }
  }
  graph.forEachNode((id) => {
    if (!seen.has(id)) graph.dropNode(id);
  });
  graph.clearEdges();
  for (const e of data.edges) {
    if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
      graph.mergeEdge(e.source, e.target, { size: Math.min(1 + e.weight, 5) });
    }
  }
  return added;
}

/** Every concept ever explored, across conversations (D2), as a force-directed WebGL graph. */
export function PersonalView({ live, onOpenConcept }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef(new Graph<NodeAttrs>());
  const sigmaRef = useRef<Sigma<NodeAttrs> | null>(null);
  const hoverRef = useRef<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [hover, setHover] = useState<Hover | null>(null);
  const [count, setCount] = useState<number | null>(null);

  // Sigma is created once; data updates mutate the graph and Sigma redraws on its own.
  useEffect(() => {
    const graph = graphRef.current;
    const renderer = new Sigma(graph, container.current!, {
      labelColor: { color: cssVar('--text') },
      defaultEdgeColor: cssVar('--edge'),
      labelRenderedSizeThreshold: 7,
      labelFont: 'system-ui, sans-serif',
      zIndex: true,
      nodeReducer: (node, data) => {
        const h = hoverRef.current;
        if (!h || node === h || graph.areNeighbors(node, h)) return { ...data, highlighted: node === h };
        return { ...data, color: cssVar('--border'), label: '' };
      },
      edgeReducer: (edge, data) => {
        const h = hoverRef.current;
        if (!h || graph.hasExtremity(edge, h)) return data;
        return { ...data, hidden: true };
      },
    });
    sigmaRef.current = renderer;

    const place = (id: string) => {
      const d = renderer.getNodeDisplayData(id);
      if (!d) return;
      const p = renderer.graphToViewport({ x: d.x, y: d.y });
      setHover({ id, x: p.x, y: p.y });
    };
    renderer.on('enterNode', ({ node }) => {
      clearTimeout(closeTimer.current);
      hoverRef.current = node;
      place(node);
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('leaveNode', () => {
      closeTimer.current = setTimeout(() => {
        hoverRef.current = null;
        setHover(null);
        renderer.refresh({ skipIndexation: true });
      }, 180);
    });
    renderer.on('clickNode', ({ node }) => onOpenConcept(node));
    renderer.getCamera().on('updated', () => {
      if (hoverRef.current) place(hoverRef.current);
    });
    // Lets end-to-end tests find a concept on screen; WebGL nodes are not in the DOM.
    (window as unknown as { __kgPersonal?: unknown }).__kgPersonal = {
      position: (label: string) => {
        const id = graph.findNode((_, a) => a.label === label);
        const d = id ? renderer.getNodeDisplayData(id) : undefined;
        return d ? renderer.graphToViewport({ x: d.x, y: d.y }) : null;
      },
    };
    return () => {
      clearTimeout(closeTimer.current);
      renderer.kill();
      sigmaRef.current = null;
    };
  }, [onOpenConcept]);

  // Load on mount and on every live change.
  useEffect(() => {
    let cancelled = false;
    api.graph().then((data) => {
      if (cancelled) return;
      const graph = graphRef.current;
      const first = graph.order === 0;
      const added = merge(graph, data, { node: cssVar('--node'), recent: cssVar('--accent') });
      if (first || added > 0) {
        const settings = forceAtlas2.inferSettings(graph);
        const iterations = first ? (graph.order > 2000 ? 40 : 200) : 30;
        forceAtlas2.assign(graph, { iterations, settings: { ...settings, barnesHutOptimize: graph.order > 500 } });
      }
      setCount(graph.order);
    });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const hovered = hover && graphRef.current.hasNode(hover.id) ? graphRef.current.getNodeAttributes(hover.id) : null;

  return (
    <>
      <div ref={container} className="sigma" data-testid="personal-graph" />
      {count === 0 && (
        <div className="empty">
          <p>Il grafo personale è vuoto.</p>
          <p className="muted">Ogni concetto esplorato in una conversazione comparirà qui.</p>
        </div>
      )}
      {count !== null && count > 0 && (
        <div className="overlay-bar muted small" data-testid="concept-count">
          {count} {count === 1 ? 'concetto' : 'concetti'}
        </div>
      )}
      {hover && hovered && (
        <div
          className="tooltip floating"
          role="tooltip"
          style={{ left: hover.x, top: hover.y + 14 }}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={() => {
            hoverRef.current = null;
            setHover(null);
            sigmaRef.current?.refresh({ skipIndexation: true });
          }}
        >
          <strong>{hovered.label}</strong>
          <p>{hovered.summary || 'Nessun riassunto.'}</p>
          <p className="muted small">
            Visto {hovered.visitCount} {hovered.visitCount === 1 ? 'volta' : 'volte'}
          </p>
          <button type="button" onClick={() => onOpenConcept(hover.id)}>
            Approfondisci
          </button>
        </div>
      )}
    </>
  );
}
