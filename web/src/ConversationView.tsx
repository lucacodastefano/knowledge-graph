import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  ConnectionMode,
  type Connection,
  type NodeChange,
} from '@xyflow/react';
import { api, explain, type Conversation, type ConversationTree } from './api.ts';
import type { Found, LiveEvent } from './App.tsx';
import {
  alsoIn,
  buildEdges,
  layout,
  neighbourhood,
  type EdgeData,
  type Half,
  type LayoutKind,
  type VisitNode as VisitNodeType,
} from './layout.ts';
import { VisitNode } from './VisitNode.tsx';

/** A dashed cross-link (D1) drawn along the route the layout picked around the other nodes. */
function CrossEdge({ id, data, sourceX, sourceY, targetX, targetY }: EdgeProps<Edge<EdgeData>>) {
  return <BaseEdge id={id} path={data?.path ?? `M${sourceX},${sourceY} L${targetX},${targetY}`} />;
}

/**
 * A free relation between two concepts: dotted line with its label. Clicking it arms it: a red ✕ (or Canc) removes
 * it, ✎ sets the label.
 */
function RelationEdge({ id, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps<Edge<EdgeData>>) {
  const [path, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const d = data as unknown as RelationData;
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={24} />
      {(d.label || d.armed) && (
        <EdgeLabelRenderer>
          <div className="relation-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
            {d.label && <span>{d.label}</span>}
            {d.armed && (
              <>
                <button type="button" className="relation-edit" aria-label="Etichetta" title="Etichetta" onClick={d.onLabel}>
                  ✎
                </button>
                <button type="button" className="relation-remove" aria-label="Rimuovi la relazione" title="Rimuovi (Canc)" onClick={d.onRemove}>
                  ✕
                </button>
              </>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A parent-child edge of the tree: clicking it arms a red ✕ (or Canc) that detaches the child with its subtree. */
function TreeEdge({ id, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps<Edge<EdgeData>>) {
  const d = data as unknown as { shape?: string; armed: boolean; onRemove: () => void };
  const args = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, x, y] = d.shape === 'straight' ? getStraightPath(args) : d.shape === 'smoothstep' ? getSmoothStepPath(args) : getBezierPath(args);
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={24} />
      {d.armed && (
        <EdgeLabelRenderer>
          <div className="relation-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
            <button type="button" className="relation-remove" aria-label="Scollega il nodo" title="Scollega dal padre (Canc)" onClick={d.onRemove}>
              ✕
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

interface RelationData {
  from: string;
  to: string;
  label?: string;
  armed: boolean;
  onRemove: () => void;
  onLabel: () => void;
}

/** One undoable canvas action (Ctrl+Z / Ctrl+Y). */
interface Step {
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

/** The grey dashed edge previewing where a dragged node would attach. */
function previewEdge(drop: { drag: string; target: string }, nodes: VisitNodeType[]): Edge<EdgeData> {
  const x = (id: string) => nodes.find((n) => n.id === id)?.position.x ?? 0;
  const targetOnLeft = x(drop.target) <= x(drop.drag);
  return {
    id: 'preview',
    source: drop.target,
    target: drop.drag,
    sourceHandle: targetOnLeft ? 's-right' : 's-left',
    targetHandle: targetOnLeft ? 't-left' : 't-right',
    type: 'straight',
    className: 'preview',
    selectable: false,
    focusable: false,
  };
}

const nodeTypes = { visit: VisitNode };
const edgeTypes = { cross: CrossEdge, relation: RelationEdge, tree: TreeEdge };
const FRESH_MS = 1600;
/** WP6: the tooltip opens after a short dwell and closes at once, with a grace period to reach its button. */
/** How close (screen px between edges) a dragged node must get to another one to preview attaching to it. */
const DROP_RADIUS = 120;
const OPEN_DELAY_MS = 700;
const CLOSE_GRACE_MS = 150;
const AUTO = '';
const LAYOUTS: { kind: LayoutKind; label: string }[] = [
  { kind: 'radial', label: 'Radiale' },
  { kind: 'mindmap', label: 'Mappa mentale' },
  { kind: 'tree', label: 'Albero' },
];
const LAYOUT_KEY = 'kg.layout';

/** The chosen layout is remembered in this browser; storage may be unavailable, radial is the default (WP7). */
function savedLayout(): LayoutKind {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return LAYOUTS.some((l) => l.kind === v) ? (v as LayoutKind) : 'radial';
  } catch {
    return 'radial';
  }
}

interface Props {
  live: LiveEvent | null;
  found: Found | null;
  onOpenConcept: (conceptId: string) => void;
  /** A click on empty canvas: the app closes the detail panel. */
  onBackgroundClick?: () => void;
}

/** The conversation as a navigation tree (D1). */
function Tree({ live, found, onOpenConcept, onBackgroundClick }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [pinned, setPinned] = useState<string>(AUTO);
  const [tree, setTree] = useState<ConversationTree | null>(null);
  const [nodes, setNodes] = useState<VisitNodeType[]>([]);
  const [edges, setEdges] = useState<Edge<EdgeData>[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<LayoutKind>(savedLayout);
  const laidOut = useRef<LayoutKind>(kind);
  /** The whole tree is framed on a new conversation or layout; later updates only move to the current node. */
  const fitAll = useRef(true);
  const [hovered, setHovered] = useState<string | null>(null);
  // The node under the pointer, at once (the tooltip waits for a dwell), and the one clicked: both highlight
  // their neighbourhood, the pointer first.
  const [pointed, setPointed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Entering a node closes any other tooltip at once and opens its own after a dwell; staying on the open
  // tooltip's button keeps it; leaving closes it after a short grace period.
  const onHover = useCallback((id: string | null) => {
    clearTimeout(hoverTimer.current);
    if (id === null) {
      hoverTimer.current = setTimeout(() => {
        setHovered(null);
        setPointed(null);
      }, CLOSE_GRACE_MS);
      return;
    }
    setPointed(id);
    setHovered((prev) => (prev === id ? prev : null));
    hoverTimer.current = setTimeout(() => setHovered(id), OPEN_DELAY_MS);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearTimeout(hoverTimer.current);
        setHovered(null);
        setSelected(null);
        setPointed(null);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const flow = useReactFlow();
  const fail = useCallback((e: unknown) => setNotice(explain((e as Error).message)), []);
  /** Back to the laid-out positions after a drag that moved nothing. */
  const relayout = useCallback(() => setTree((t) => (t ? { ...t } : t)), []);
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  /** Runs a canvas action and remembers how to undo it; a new action clears what could be redone. */
  const act = useCallback(
    (step: Step) => {
      setNotice(null);
      step.redo().then(
        () => {
          undoStack.current.push(step);
          redoStack.current = [];
        },
        (e: unknown) => {
          fail(e);
          relayout();
        },
      );
    },
    [fail, relayout],
  );
  const travel = useCallback(
    (from: Step[], to: Step[], dir: 'undo' | 'redo') => {
      const step = from.pop();
      if (!step) return;
      setNotice(null);
      step[dir]().then(
        () => void to.push(step),
        (e: unknown) => {
          fail(e);
          from.push(step);
        },
      );
    },
    [fail],
  );
  // While a node is dragged, the nearest node within DROP_RADIUS (screen px between their edges) is the attach target:
  // it is highlighted and a grey dashed preview edge joins it to the dragged node. Releasing attaches the dragged node
  // (with its subtree) there; out of range it just stays where it was dropped. A node and its descendants never qualify.
  const [drop, setDrop] = useState<{ drag: string; target: string } | null>(null);
  const dropRef = useRef<{ drag: string; target: string } | null>(null);
  const setDropBoth = useCallback((d: { drag: string; target: string } | null) => {
    dropRef.current = d;
    setDrop((prev) => (prev?.drag === d?.drag && prev?.target === d?.target ? prev : d));
  }, []);
  const onDrag = useCallback(
    (_: unknown, node: VisitNodeType) => {
      if (!tree) return;
      const banned = new Set([node.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const v of tree.visits) if (v.parentVisitId && banned.has(v.parentVisitId) && !banned.has(v.id)) banned.add(v.id), (grew = true);
      }
      const zoom = flow.getZoom();
      const box = (n: VisitNodeType) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? 190, h: n.measured?.height ?? 46 });
      const me = box(node);
      let best: { id: string; gap: number } | null = null;
      for (const other of flow.getNodes() as VisitNodeType[]) {
        if (banned.has(other.id)) continue;
        const o = box(other);
        const gx = Math.max(0, Math.max(o.x - (me.x + me.w), me.x - (o.x + o.w)));
        const gy = Math.max(0, Math.max(o.y - (me.y + me.h), me.y - (o.y + o.h)));
        const gap = Math.hypot(gx, gy) * zoom;
        if (gap <= DROP_RADIUS && (!best || gap < best.gap)) best = { id: other.id, gap };
      }
      setDropBoth(best ? { drag: node.id, target: best.id } : null);
    },
    [tree, flow, setDropBoth],
  );
  const onDragStop = useCallback(
    (_: unknown, node: VisitNodeType) => {
      const d = dropRef.current;
      setDropBoth(null);
      const old = node.data.visit.parentVisitId;
      if (!d || d.drag !== node.id || d.target === old) return;
      act({
        redo: () => api.editVisit(node.id, { parentVisitId: d.target }),
        undo: () => api.editVisit(node.id, { parentVisitId: old }),
      });
    },
    [act, setDropBoth],
  );
  // Pulling a line from one node to another relates their concepts (a different idea, unlike "Unisci a…").
  const onConnect = useCallback(
    (c: Connection) => {
      const from = tree?.visits.find((v) => v.id === c.source);
      const to = tree?.visits.find((v) => v.id === c.target);
      if (!from || !to) return;
      act({ redo: () => api.relate(from.conceptId, to.conceptId), undo: () => api.unrelate(from.conceptId, to.conceptId) });
    },
    [tree, act],
  );
  const relationOf = useCallback((id: string) => tree?.relations.find((r) => `r-${r.from}-${r.to}` === id), [tree]);
  const removeRelation = useCallback(
    (id: string) => {
      if (id.startsWith('t-')) {
        // A parent-child edge: the child leaves its parent with its whole subtree and becomes a top-level node.
        const child = tree?.visits.find((v) => `t-${v.id}` === id);
        if (!child) return;
        const old = child.parentVisitId;
        setArmed(null);
        return act({ redo: () => api.editVisit(child.id, { parentVisitId: null }), undo: () => api.editVisit(child.id, { parentVisitId: old }) });
      }
      const r = relationOf(id);
      if (!r) return;
      setArmed(null);
      act({ redo: () => api.unrelate(r.from, r.to), undo: () => api.relate(r.from, r.to, r.label) });
    },
    [relationOf, act, tree],
  );
  const labelRelation = useCallback(
    (id: string) => {
      const r = relationOf(id);
      if (!r) return;
      const label = window.prompt('Etichetta della relazione (vuota per toglierla)', r.label ?? '');
      if (label === null) return;
      act({ redo: () => api.relate(r.from, r.to, label.trim() || null), undo: () => api.relate(r.from, r.to, r.label ?? null) });
    },
    [relationOf, act],
  );
  const onEdgeClick = useCallback((_: unknown, edge: Edge<EdgeData>) => {
    if (edge.className?.includes('relation') || edge.id.startsWith('t-')) setArmed((a) => (a === edge.id ? null : edge.id));
  }, []);
  // Canc removes the armed relation; Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) walk back and forth through the actions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if ((e.key === 'Delete' || e.key === 'Backspace') && armed) {
        e.preventDefault();
        removeRelation(armed);
      } else if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        travel(undoStack.current, redoStack.current, 'undo');
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        travel(redoStack.current, undoStack.current, 'redo');
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [armed, removeRelation, travel]);
  // Keeps React Flow's measured sizes in our state: without them every rebuild resets nodes to
  // unmeasured (hidden), and a rebuild racing the resize observer can leave them hidden for good.
  const onNodesChange = useCallback(
    (changes: NodeChange<VisitNodeType>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const knownIds = useRef<Set<string>>(new Set());
  const lastCurrent = useRef<string | null | undefined>(undefined);
  /** Mind map halves of the first-level branches, so a growing map moves a branch only when the balance pays. */
  const halves = useRef<Map<string, Half>>(new Map());
  /** The view to frame once React Flow has the new positions: everything, the current node, or nothing. */
  const pendingFit = useRef<'all' | 'current' | null>(null);

  const activeId = pinned || conversations[0]?.id || null;

  const loadConversations = useCallback(() => api.conversations().then(setConversations), []);
  const loadTree = useCallback(() => {
    if (activeId) api.tree(activeId).then(setTree);
    else setTree(null);
  }, [activeId]);

  useEffect(() => void loadConversations(), [loadConversations]);
  useEffect(() => {
    knownIds.current = new Set();
    undoStack.current = [];
    redoStack.current = [];
    setArmed(null);
    fitAll.current = true;
    halves.current = new Map();
    setSelected(null);
    loadTree();
  }, [loadTree]);

  // Live updates: any change reloads the list and, when relevant, the open tree.
  useEffect(() => {
    if (!live) return;
    void loadConversations();
    const e = live.event;
    const conv = 'conversationId' in e ? e.conversationId : 'visit' in e ? e.visit.conversationId : null;
    // Concept corrections can touch any conversation.
    if (conv === activeId || e.type.startsWith('concept.')) loadTree();
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebuild nodes and layout whenever the tree changes; new nodes glow for a moment.
  useEffect(() => {
    if (!tree) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const added = tree.visits.filter((v) => !knownIds.current.has(v.id)).map((v) => v.id);
    const firstLoad = knownIds.current.size === 0;
    tree.visits.forEach((v) => knownIds.current.add(v.id));
    if (!firstLoad && added.length) {
      setFresh(new Set(added));
      setTimeout(() => setFresh(new Set()), FRESH_MS);
    }
    let cancelled = false;
    if (laidOut.current !== kind) fitAll.current = true;
    laidOut.current = kind;
    void layout(tree.visits, kind, halves.current).then((placement) => {
      if (cancelled) return;
      const pos = placement.position;
      if (kind === 'mindmap') halves.current = placement.branches;
      const also = alsoIn(tree.visits);
      setNodes((prev) => {
        const measured = new Map(prev.map((n) => [n.id, n.measured]));
        return tree.visits.map((v) => ({
          id: v.id,
          measured: measured.get(v.id),
          type: 'visit',
          position: pos.get(v.id) ?? { x: 0, y: 0 },
          data: {
            visit: v,
            current: v.id === tree.conversation.currentVisitId,
            fresh: false,
            hovered: false,
            match: false,
            focus: false,
            related: false,
            dim: false,
            also: also.get(v.id) ?? [],
            onHover,
            onOpen: onOpenConcept,
          },
        }));
      });
      // Free relations between concepts (XMind-style lines): drawn between the first node of each concept.
      const first = new Map<string, string>();
      for (const v of tree.visits) if (!first.has(v.conceptId)) first.set(v.conceptId, v.id);
      const relEdges: Edge<EdgeData>[] = [];
      for (const r of tree.relations) {
        const a = first.get(r.from);
        const b = first.get(r.to);
        if (!a || !b) continue;
        const leftToRight = (pos.get(a)?.x ?? 0) <= (pos.get(b)?.x ?? 0);
        relEdges.push({
          id: `r-${r.from}-${r.to}`,
          source: a,
          target: b,
          sourceHandle: leftToRight ? 's-right' : 's-left',
          targetHandle: leftToRight ? 't-left' : 't-right',
          type: 'relation',
          className: 'relation',
          data: { from: r.from, to: r.to, label: r.label, armed: false, onRemove: () => undefined, onLabel: () => undefined },
        });
      }
      setEdges([...buildEdges(tree.visits, kind, placement), ...relEdges]);
      // Only a new node or a new current node moves the view: touching nodes or editing relations never does.
      const current = tree.conversation.currentVisitId;
      pendingFit.current = fitAll.current ? 'all' : added.length > 0 || current !== lastCurrent.current ? 'current' : null;
      lastCurrent.current = current;
      fitAll.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [tree, kind, onHover, onOpenConcept]);

  // Frame the view after React Flow has taken the new positions and measured every node: fitting earlier
  // frames the old positions (or nothing, on the first load).
  useEffect(() => {
    if (!pendingFit.current || !nodes.length || !nodes.every((n) => n.measured?.width)) return;
    const fit = pendingFit.current;
    pendingFit.current = null;
    const cur = tree?.conversation.currentVisitId;
    requestAnimationFrame(() => {
      if (fit === 'all') void flow.fitView({ padding: 0.2, maxZoom: 1.2 });
      else if (cur) void flow.fitView({ nodes: [{ id: cur }], padding: 2, maxZoom: 1.2, duration: 400 });
    });
  }, [nodes, tree, flow]);

  // The concept picked in the search glows in the tree, and the view moves to it.
  const matchConcept = found?.conceptId ?? null;
  useEffect(() => {
    if (!found || !tree) return;
    const ids = tree.visits.filter((v) => v.conceptId === found.conceptId).map((v) => ({ id: v.id }));
    if (ids.length) void flow.fitView({ nodes: ids, padding: 1, maxZoom: 1.2, duration: 400 });
  }, [found]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight around the pointed or selected node: parent, children and the other nodes of its concept; the
  // rest fades. Highlighted edges are drawn last, so they stay on top of the faded ones.
  const near = useMemo(() => {
    const focus = pointed ?? selected;
    return focus && tree ? neighbourhood(tree.visits, focus) : null;
  }, [pointed, selected, tree]);
  const focusId = near ? (pointed ?? selected) : null;
  const shown = useMemo(
    () =>
      nodes.map((n) => {
        const match = n.data.visit.conceptId === matchConcept;
        const focus = n.id === focusId || n.id === drop?.target;
        const related = !focus && !!near?.nodes.has(n.id);
        const dim = !!near && !focus && !related;
        return fresh.has(n.id) || hovered === n.id || match || near
          ? { ...n, data: { ...n.data, fresh: fresh.has(n.id), hovered: hovered === n.id, match, focus, related, dim } }
          : n;
      }),
    [nodes, fresh, hovered, matchConcept, near, focusId, drop],
  );
  const base = edges;
  const shownEdges = useMemo(() => {
    const edges = base.map((e) =>
      e.className === 'relation'
        ? { ...e, data: { ...e.data, armed: e.id === armed, onRemove: () => removeRelation(e.id), onLabel: () => labelRelation(e.id) } as EdgeData }
        : e.id.startsWith('t-')
          ? { ...e, type: 'tree', data: { shape: e.type, armed: e.id === armed, onRemove: () => removeRelation(e.id) } as EdgeData }
          : e,
    );
    const previewed = drop ? [...edges, previewEdge(drop, nodes)] : edges;
    if (!near || drop) return previewed;
    const mark = (e: Edge<EdgeData>, cls: string) => ({ ...e, className: [e.className, cls].filter(Boolean).join(' ') });
    return [
      ...edges.filter((e) => !near.edges.has(e.id)).map((e) => mark(e, 'dim')),
      ...edges.filter((e) => near.edges.has(e.id)).map((e) => mark(e, 'related')),
    ];
  }, [base, near, armed, removeRelation, labelRelation, drop, nodes]);

  return (
    <>
      <div className="overlay-bar">
        <select value={pinned} onChange={(e) => setPinned(e.target.value)} aria-label="Conversazione">
          <option value={AUTO}>Segui l'ultima conversazione</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} · {new Date(c.startedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
            </option>
          ))}
        </select>
        <select
          value={kind}
          aria-label="Layout"
          onChange={(e) => {
            const k = e.target.value as LayoutKind;
            setKind(k);
            try {
              localStorage.setItem(LAYOUT_KEY, k);
            } catch {
              // Not remembered: the choice still applies to this page.
            }
          }}
        >
          {LAYOUTS.map((l) => (
            <option key={l.kind} value={l.kind}>
              {l.label}
            </option>
          ))}
        </select>
        {notice && (
          <span className="notice error" role="alert" onClick={() => setNotice(null)}>
            {notice}
          </span>
        )}
      </div>
      {tree && tree.visits.length > 0 ? (
        <ReactFlow
          nodes={shown}
          edges={shownEdges}
          onNodesChange={onNodesChange}
          onNodeClick={(_, n) => setSelected((s) => (s === n.id ? null : n.id))}
          onPaneClick={() => {
            setSelected(null);
            setArmed(null);
            onBackgroundClick?.();
          }}
          deleteKeyCode={null}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable
          nodesConnectable
          connectionMode={ConnectionMode.Loose}
          onNodeDrag={onDrag}
          onNodeDragStop={onDragStop}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      ) : (
        <div className="empty">
          <p>Il canvas è vuoto.</p>
          <p className="muted">Inizia a chattare con un modello collegato via MCP: i concetti compariranno qui.</p>
        </div>
      )}
    </>
  );
}

export function ConversationView(props: Props) {
  return (
    <ReactFlowProvider>
      <Tree {...props} />
    </ReactFlowProvider>
  );
}
