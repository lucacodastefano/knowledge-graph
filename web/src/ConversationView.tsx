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
  type Placement,
  type Side,
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
          <div className={`relation-label nodrag nopan${(d as { hover?: boolean }).hover ? ' hover' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
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

/** The two short ends that would join: the target's (children side) and the dragged node's. */
interface Drop {
  drag: string;
  target: string;
  targetSide: 'left' | 'right';
  dragSide: 'left' | 'right';
}

/** Short ends of a node that children can attach to, by the layout's growth direction. */
function growth(kind: LayoutKind, n: VisitNodeType, placement: Placement | null, centreX: number): ('left' | 'right')[] {
  const isRoot = !n.data.visit.parentVisitId;
  if (kind === 'tree') return ['right'];
  const own = placement?.side.get(n.id);
  if (kind === 'mindmap') return isRoot ? ['left', 'right'] : [own === 'left' ? 'left' : 'right'];
  // Radial: outward from the centre of the picture; the centre itself accepts both ends.
  const x = n.position.x + (n.measured?.width ?? 190) / 2;
  return isRoot ? ['left', 'right'] : [x >= centreX ? 'right' : 'left'];
}

/** The grey dashed edge previewing where a dragged node would attach. */
function previewEdge(drop: Drop): Edge<EdgeData> {
  return {
    id: 'preview',
    source: drop.target,
    target: drop.drag,
    sourceHandle: `s-${drop.targetSide}`,
    targetHandle: `t-${drop.dragSide}`,
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
/** How close (screen px between short ends) a free-ended node must get to another one to preview attaching to it. */
const DROP_RADIUS = 20;
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
  // While a node without a parent is dragged, the nearest node within DROP_RADIUS (screen px between their edges) is the attach target:
  // it is highlighted and a grey dashed preview edge joins it to the dragged node. Releasing attaches the dragged node
  // (with its subtree) there; out of range it just stays where it was dropped. A node and its descendants never qualify.
  const [drop, setDrop] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const setDropBoth = useCallback((d: Drop | null) => {
    dropRef.current = d;
    setDrop((prev) => (prev?.drag === d?.drag && prev?.target === d?.target && prev?.targetSide === d?.targetSide ? prev : d));
  }, []);
  /** Sides an attach was anchored to, so the final edge leaves and enters exactly where the preview showed. */
  const attachSides = useRef<Map<string, { parent: string; side: Side }>>(new Map());
  // Dragging a node carries its whole subtree rigidly, live: the same offsets, so edge lengths and angles stay.
  // Positions chosen by hand are kept for this page session (`manual`) so a refresh of the tree does not undo them.
  const manual = useRef<Map<string, { x: number; y: number }>>(new Map());
  const dragStart = useRef<Map<string, { x: number; y: number }> | null>(null);
  const subtreeOf = useCallback(
    (rootId: string) => {
      const ids = new Set([rootId]);
      for (let grew = true; grew && tree; ) {
        grew = false;
        for (const v of tree.visits) if (v.parentVisitId && ids.has(v.parentVisitId) && !ids.has(v.id)) ids.add(v.id), (grew = true);
      }
      return ids;
    },
    [tree],
  );
  const placeNodes = useCallback((positions: Map<string, { x: number; y: number }>) => {
    setNodes((ns) => ns.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)));
  }, []);
  const onDragStart = useCallback(
    (_: unknown, node: VisitNodeType) => {
      // Dragging closes the tooltip and the Approfondisci panel at once.
      clearTimeout(hoverTimer.current);
      setHovered(null);
      onBackgroundClick?.();
      const ids = subtreeOf(node.id);
      dragStart.current = new Map(flow.getNodes().filter((n) => ids.has(n.id)).map((n) => [n.id, { ...n.position }]));
    },
    [subtreeOf, flow, onBackgroundClick],
  );
  const onDrag = useCallback(
    (_: unknown, node: VisitNodeType) => {
      if (!tree) return;
      const start = dragStart.current;
      const origin = start?.get(node.id);
      if (start && origin) {
        const dx = node.position.x - origin.x;
        const dy = node.position.y - origin.y;
        placeNodes(new Map([...start].filter(([id]) => id !== node.id).map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }])));
      }
      // Only a node with a free end (no parent) snaps: one that has a parent moves rigidly with its subtree.
      if (node.data.visit.parentVisitId) {
        setDropBoth(null);
        return;
      }
      const banned = subtreeOf(node.id);
      // Magnetic zones: only the short ends (left / right) of a node. The target offers the end facing the direction its
      // children grow; the dragged node must bring the matching end (opposite in a tree or mind map, the one facing the
      // target in the radial layout) within DROP_RADIUS.
      const zoom = flow.getZoom();
      const box = (n: VisitNodeType) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? 190, h: n.measured?.height ?? 46 });
      const end = (n: VisitNodeType, side: Side) => {
        const b = box(n);
        return { x: side === 'right' ? b.x + b.w : b.x, y: b.y + b.h / 2 };
      };
      const all = flow.getNodes() as VisitNodeType[];
      const roots = all.filter((n) => !n.data.visit.parentVisitId && !banned.has(n.id));
      const centreX = roots.length ? roots.reduce((s, n) => s + box(n).x + box(n).w / 2, 0) / roots.length : 0;
      const me = box(node);
      let best: (Drop & { gap: number }) | null = null;
      for (const other of all) {
        if (banned.has(other.id)) continue;
        for (const targetSide of growth(kind, other, lastPlacement.current, centreX)) {
          const t = end(other, targetSide);
          const dragSide: Side = kind === 'radial' ? (t.x >= me.x + me.w / 2 ? 'right' : 'left') : targetSide === 'right' ? 'left' : 'right';
          const d = end(node, dragSide);
          const gap = Math.hypot(t.x - d.x, t.y - d.y) * zoom;
          if (gap <= DROP_RADIUS && (!best || gap < best.gap)) best = { drag: node.id, target: other.id, targetSide, dragSide, gap };
        }
      }
      setDropBoth(best);
    },
    [tree, flow, kind, setDropBoth, subtreeOf, placeNodes],
  );
  const onDragStop = useCallback(
    (_: unknown, node: VisitNodeType) => {
      const d = dropRef.current;
      setDropBoth(null);
      const start = dragStart.current;
      dragStart.current = null;
      const old = node.data.visit.parentVisitId;
      if (d && d.drag === node.id && d.target !== old) {
        // Attached: the tree is laid out again, the hand-placed positions of this subtree no longer apply.
        for (const id of start?.keys() ?? []) manual.current.delete(id);
        attachSides.current.set(node.id, { parent: d.target, side: d.targetSide });
        act({
          redo: () => api.editVisit(node.id, { parentVisitId: d.target }),
          undo: () => api.editVisit(node.id, { parentVisitId: old }),
        });
        return;
      }
      if (!start) return;
      // Dropped in place: the subtree stays where it was put, and Ctrl+Z puts all of it back.
      const now = new Map(flow.getNodes().filter((n) => start.has(n.id)).map((n) => [n.id, { ...n.position }]));
      const here = start.get(node.id)!;
      if (now.get(node.id)!.x === here.x && now.get(node.id)!.y === here.y) return;
      const apply = (positions: Map<string, { x: number; y: number }>) => {
        for (const [id, p] of positions) manual.current.set(id, p);
        placeNodes(positions);
        return Promise.resolve();
      };
      act({ redo: () => apply(now), undo: () => apply(start) });
    },
    [act, setDropBoth, flow, placeNodes],
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
  // Hovering an edge lifts it (with its label) above the nodes that cover it, which fade; its endpoints stay opaque.
  const [edgeHover, setEdgeHover] = useState<{ id: string; covering: Set<string> } | null>(null);
  const onEdgeEnter = useCallback(
    (_: unknown, edge: Edge<EdgeData>) => {
      const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(edge.id)}"] .react-flow__edge-path`);
      const covering = new Set<string>();
      if (path?.getTotalLength) {
        const len = path.getTotalLength();
        const pts: DOMPoint[] = [];
        for (let at = 0; at <= len; at += 8) pts.push(path.getPointAtLength(at));
        pts.push(path.getPointAtLength(len));
        for (const n of flow.getNodes()) {
          if (n.id === edge.source || n.id === edge.target) continue;
          const w = n.measured?.width ?? 190;
          const h = n.measured?.height ?? 46;
          if (pts.some((p) => p.x >= n.position.x && p.x <= n.position.x + w && p.y >= n.position.y && p.y <= n.position.y + h)) covering.add(n.id);
        }
      }
      setEdgeHover({ id: edge.id, covering });
    },
    [flow],
  );
  const onEdgeLeave = useCallback(() => setEdgeHover(null), []);
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        // The selected node goes (its children move up to its parent); the concept is dropped if nothing else uses it.
        e.preventDefault();
        const v = tree?.visits.find((x) => x.id === selected);
        if (!v || !window.confirm(`Eliminare il nodo «${v.title}»? I suoi figli salgono al padre.`)) return;
        setSelected(null);
        setNotice(null);
        api.deleteVisit(v.id).catch(fail);
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
  }, [armed, selected, tree, fail, removeRelation, travel]);
  // Keeps React Flow's measured sizes in our state: without them every rebuild resets nodes to
  // unmeasured (hidden), and a rebuild racing the resize observer can leave them hidden for good.
  const onNodesChange = useCallback(
    (changes: NodeChange<VisitNodeType>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const knownIds = useRef<Set<string>>(new Set());
  const needsLayout = useRef(false);
  const lastPlacement = useRef<Placement | null>(null);
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
    lastPlacement.current = null;
    needsLayout.current = false;
    manual.current.clear();
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
    const kindChanged = laidOut.current !== kind;
    if (kindChanged) {
      fitAll.current = true;
      manual.current.clear();
    }
    laidOut.current = kind;
    // Auto layout runs for new nodes and when the layout is switched. After any other edit (removing a relation,
    // moving, attaching, detaching, undo) every node stays exactly where it is: only the edges change.
    // Two quick reloads can cancel the layout of the first one: keep asking for it until one has been applied.
    if (added.length > 0) needsLayout.current = true;
    const keep = !firstLoad && !kindChanged && !needsLayout.current && lastPlacement.current !== null;
    const kept = (): Placement => {
      const previous = lastPlacement.current!;
      const current = new Map(flow.getNodes().map((n) => [n.id, n.position]));
      const position = new Map(tree.visits.map((v) => [v.id, current.get(v.id) ?? previous.position.get(v.id) ?? { x: 0, y: 0 }]));
      const side = new Map<string, Side>();
      for (const v of tree.visits) {
        if (!v.parentVisitId) continue;
        const from = position.get(v.parentVisitId);
        const to = position.get(v.id);
        const anchored = attachSides.current.get(v.id);
        if (anchored && anchored.parent === v.parentVisitId) {
          side.set(v.id, anchored.side);
          continue;
        }
        side.set(v.id, kind === 'radial' ? (previous.side.get(v.id) ?? 'around') : from && to && from.x > to.x ? 'left' : 'right');
      }
      return { position, side, branches: previous.branches };
    };
    void (keep ? Promise.resolve(kept()) : layout(tree.visits, kind, halves.current)).then((placement) => {
      if (cancelled) return;
      lastPlacement.current = placement;
      if (!keep) {
        needsLayout.current = false;
        attachSides.current.clear();
      }
      const pos = placement.position;
      if (kind === 'mindmap') halves.current = placement.branches;
      const also = alsoIn(tree.visits);
      setNodes((prev) => {
        const measured = new Map(prev.map((n) => [n.id, n.measured]));
        return tree.visits.map((v) => ({
          id: v.id,
          measured: measured.get(v.id),
          type: 'visit',
          position: manual.current.get(v.id) ?? pos.get(v.id) ?? { x: 0, y: 0 },
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
        const cover = !!edgeHover?.covering.has(n.id);
        return fresh.has(n.id) || hovered === n.id || match || near || cover
          ? { ...n, data: { ...n.data, fresh: fresh.has(n.id), hovered: hovered === n.id, match, focus, related, dim, cover } }
          : n;
      }),
    [nodes, fresh, hovered, matchConcept, near, focusId, drop, edgeHover],
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
    const previewed = drop ? [...edges, previewEdge(drop)] : edges;
    if (edgeHover && !drop) {
      // The hovered edge goes last and on top, thicker and in full colour, with its label raised.
      const lift = (e: Edge<EdgeData>) => ({ ...e, className: [e.className, 'hover'].filter(Boolean).join(' '), zIndex: 1000, data: { ...e.data, hover: true } as EdgeData });
      return [...edges.filter((e) => e.id !== edgeHover.id), ...edges.filter((e) => e.id === edgeHover.id).map(lift)];
    }
    if (!near || drop) return previewed;
    const mark = (e: Edge<EdgeData>, cls: string) => ({ ...e, className: [e.className, cls].filter(Boolean).join(' ') });
    return [
      ...edges.filter((e) => !near.edges.has(e.id)).map((e) => mark(e, 'dim')),
      ...edges.filter((e) => near.edges.has(e.id)).map((e) => mark(e, 'related')),
    ];
  }, [base, near, armed, removeRelation, labelRelation, drop, nodes, edgeHover]);

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
          onNodeDragStart={onDragStart}
          onNodeDrag={onDrag}
          onNodeDragStop={onDragStop}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          onEdgeMouseEnter={onEdgeEnter}
          onEdgeMouseLeave={onEdgeLeave}
          onNodeDoubleClick={(_, n) => onOpenConcept(n.data.visit.conceptId)}
          zoomOnDoubleClick={false}
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
