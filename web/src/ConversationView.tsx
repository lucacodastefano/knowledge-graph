import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type NodeChange,
} from '@xyflow/react';
import { api, type Conversation, type ConversationTree } from './api.ts';
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

const nodeTypes = { visit: VisitNode };
const edgeTypes = { cross: CrossEdge };
const FRESH_MS = 1600;
/** WP6: the tooltip opens after a short dwell and closes at once, with a grace period to reach its button. */
const OPEN_DELAY_MS = 400;
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
}

/** The conversation as a navigation tree (D1). */
function Tree({ live, found, onOpenConcept }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [pinned, setPinned] = useState<string>(AUTO);
  const [tree, setTree] = useState<ConversationTree | null>(null);
  const [nodes, setNodes] = useState<VisitNodeType[]>([]);
  const [edges, setEdges] = useState<Edge<EdgeData>[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
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
  // Keeps React Flow's measured sizes in our state: without them every rebuild resets nodes to
  // unmeasured (hidden), and a rebuild racing the resize observer can leave them hidden for good.
  const onNodesChange = useCallback(
    (changes: NodeChange<VisitNodeType>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const knownIds = useRef<Set<string>>(new Set());
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
      setEdges(buildEdges(tree.visits, kind, placement));
      pendingFit.current = fitAll.current ? 'all' : 'current';
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
        const focus = n.id === focusId;
        const related = !focus && !!near?.nodes.has(n.id);
        const dim = !!near && !focus && !related;
        return fresh.has(n.id) || hovered === n.id || match || near
          ? { ...n, data: { ...n.data, fresh: fresh.has(n.id), hovered: hovered === n.id, match, focus, related, dim } }
          : n;
      }),
    [nodes, fresh, hovered, matchConcept, near, focusId],
  );
  const shownEdges = useMemo(() => {
    if (!near) return edges;
    const mark = (e: Edge<EdgeData>, cls: string) => ({ ...e, className: [e.className, cls].filter(Boolean).join(' ') });
    return [
      ...edges.filter((e) => !near.edges.has(e.id)).map((e) => mark(e, 'dim')),
      ...edges.filter((e) => near.edges.has(e.id)).map((e) => mark(e, 'related')),
    ];
  }, [edges, near]);

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
      </div>
      {tree && tree.visits.length > 0 ? (
        <ReactFlow
          nodes={shown}
          edges={shownEdges}
          onNodesChange={onNodesChange}
          onNodeClick={(_, n) => setSelected((s) => (s === n.id ? null : n.id))}
          onPaneClick={() => setSelected(null)}
          deleteKeyCode={null}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
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
