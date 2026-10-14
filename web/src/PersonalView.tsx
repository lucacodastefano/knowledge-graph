import { useCallback, useEffect, useRef, useState } from 'react';
import { isMobile, useMobile } from './media.ts';
import Graph from 'graphology';
import Sigma from 'sigma';
import type { NodeLabelDrawingFunction } from 'sigma/rendering';
import { api, explain, type PersonalGraph } from './api.ts';
import type { Found, LiveEvent } from './App.tsx';
import { GroupSuggestions } from './GroupSuggestions.tsx';
import { ISOLATED, layoutPersonalGraph, nextGridSpot, placeNear, seeded, type Point } from './personal-layout.ts';

interface Props {
  live: LiveEvent | null;
  found: Found | null;
  onOpenConcept: (conceptId: string) => void;
  /** A click on empty canvas: the app closes the detail panel. */
  onBackgroundClick?: () => void;
  /** The concept the panel is locked on (focus mode): highlighted, and hovering no longer changes it. */
  focusId?: string | null;
  /** The concept under the pointer, or null when it leaves every node (hover mode). */
  onHoverConcept?: (conceptId: string | null) => void;
}

interface NodeAttrs {
  label: string;
  summary: string;
  visitCount: number;
  lastSeenAt: string;
  /** Conversations of the concept, the busiest first: the first one gives its colour. */
  conversationIds: string[];
  /** Distinct sources cited over its visits. */
  sourceCount: number;
  /** A superclass (it groups other concepts): drawn bigger, always labelled. */
  isSuper: boolean;
  community: string;
  x: number;
  y: number;
  size: number;
}

type ColorBy = 'community' | 'conversation';

/** One entry of the legend: a community or a conversation, with its colour slot (-1 = grey). */
interface Group {
  key: string;
  name: string;
  count: number;
  slot: number;
}

/** A community seen from afar (D2 levels): a disc over its concepts, named after its main concept. */
interface Bubble {
  id: string;
  name: string;
  count: number;
  slot: number;
  x: number;
  y: number;
  r: number;
}

/** 8 categorical slots, validated for colour-blind separation; past that, grey. */
const SLOTS = 8;
/** Above this many concepts on screen the view shows communities instead of single labels. */
const LABEL_BUDGET = 150;
const MIN_BUBBLE = 3;
/** Up to this many concepts on screen every label is drawn, nudged aside if needed, never hidden. */
const SMALL_GRAPH = 40;
const PERIODS = [
  { value: '', label: 'Sempre' },
  { value: '1', label: 'Ultime 24 ore' },
  { value: '7', label: 'Ultima settimana' },
  { value: '30', label: 'Ultimo mese' },
  { value: '365', label: 'Ultimo anno' },
];
const DAY_MS = 24 * 3600 * 1000;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const nodeSize = (visits: number) => 3 + 2.5 * Math.sqrt(visits);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function stored<T extends string | boolean>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return (typeof fallback === 'boolean' ? v === 'true' : v) as T;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string | boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private windows may refuse storage: the choice just is not remembered.
  }
}

/** Gives free colour slots to new keys, biggest first; keys keep their colour for the whole session. */
function assignSlots(slots: Map<string, number>, sizes: Map<string, number>) {
  const used = new Set([...slots.values()].filter((s) => s >= 0));
  const fresh = [...sizes.entries()].filter(([k]) => !slots.has(k)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [k] of fresh) {
    let slot = -1;
    for (let i = 0; i < SLOTS; i++)
      if (!used.has(i)) {
        slot = i;
        break;
      }
    if (slot >= 0) used.add(slot);
    slots.set(k, slot);
  }
}

/**
 * Merges the server graph into the graphology instance. The first time (or on "Riordina")
 * everything is laid out again; afterwards known concepts keep their place and new ones
 * appear next to a neighbour, so the picture does not jump while the model tracks.
 */
/** What the graph was last grouped by: when it changes, the areas of the superclasses are laid out again. */
const groupSignatures = new WeakMap<object, string>();

function merge(graph: Graph<NodeAttrs>, data: PersonalGraph, relayout: boolean, rng: () => number) {
  // Superclasses (D18): the group of a concept is the topmost superclass above it (or itself, for a top one).
  const up = new Map(data.concepts.filter((c) => c.superclassId).map((c) => [c.id, c.superclassId!]));
  const top = (id: string) => {
    let cur = id;
    for (let i = 0; up.has(cur) && i < 50; i++) cur = up.get(cur)!;
    return cur;
  };
  const supers = new Set(up.values());
  const signature = [...up.entries()].map(([a, b]) => `${a}>${b}`).sort().join(',');
  if (groupSignatures.get(graph) !== signature) relayout = true;
  groupSignatures.set(graph, signature);
  const groups = new Map<string, string>();
  for (const c of data.concepts) if (up.has(c.id) || supers.has(c.id)) groups.set(c.id, top(c.id));
  const members = new Map<string, number>();
  for (const s of up.values()) members.set(s, (members.get(s) ?? 0) + 1);

  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const c of data.concepts) {
    seen.add(c.id);
    const attrs = {
      label: c.name,
      summary: c.summary,
      visitCount: c.visitCount,
      lastSeenAt: c.lastSeenAt,
      conversationIds: c.conversationIds,
      sourceCount: c.sourceCount,
      isSuper: supers.has(c.id),
      size: supers.has(c.id) ? nodeSize(Math.max(c.visitCount, members.get(c.id) ?? 0)) + 2 : nodeSize(c.visitCount),
    };
    if (graph.hasNode(c.id)) graph.mergeNodeAttributes(c.id, attrs);
    else {
      graph.addNode(c.id, { ...attrs, community: ISOLATED, x: 0, y: 0 });
      fresh.push(c.id);
    }
  }
  graph.forEachNode((id) => {
    if (!seen.has(id)) graph.dropNode(id);
  });
  graph.clearEdges();
  for (const e of data.edges) {
    // Free (dashed) relations are not drawn here: they stay in the conversation view and the panel.
    if (!e.relation && graph.hasNode(e.source) && graph.hasNode(e.target) && e.source !== e.target) {
      graph.mergeEdge(e.source, e.target, { size: Math.min(0.6 + 0.4 * e.weight, 3), relation: !!e.relation, ...(e.label ? { label: e.label } : {}) });
    }
  }

  for (const [child, parent] of up) {
    if (!graph.hasNode(child) || !graph.hasNode(parent) || child === parent) continue;
    if (graph.hasEdge(child, parent)) graph.setEdgeAttribute(child, parent, 'isa', true);
    else if (graph.hasEdge(parent, child)) graph.setEdgeAttribute(parent, child, 'isa', true);
    else graph.addEdge(child, parent, { size: 1.4, relation: false, isa: true });
  }

  if (relayout) {
    const { community, position } = layoutPersonalGraph({
      nodes: graph.nodes(),
      // Each member is pulled to its superclass, so an area gathers around its hub (these edges are not drawn).
      edges: [...data.edges, ...[...up.entries()].map(([source, target]) => ({ source, target, weight: 2 }))],
      groups,
      sortKey: (n) => `${graph.getNodeAttribute(n, 'conversationIds')[0] ?? ''} ${graph.getNodeAttribute(n, 'label')}`,
    });
    graph.updateEachNodeAttributes((n, a) => ({ ...a, community: community.get(n)!, ...position.get(n)! }));
    return;
  }

  // Incremental: a new concept joins the community of its placed neighbours, next to one of them.
  // A new root with new children starts a community of its own beside the picture; a concept with
  // no link at all goes to the isolated grid. Known concepts never move.
  const placed = new Set(graph.filterNodes((n) => !fresh.includes(n)));
  let nextId = 0;
  graph.forEachNode((_, a) => {
    const m = /^live(\d+)$/.exec(a.community);
    if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
  });
  const queue = [...fresh];
  while (queue.length > 0) {
    const i = queue.findIndex((id) => graph.neighbors(id).some((n) => placed.has(n)));
    const id = queue.splice(Math.max(i, 0), 1)[0];
    const known = graph.neighbors(id).filter((n) => placed.has(n));
    const all: Point[] = [];
    graph.forEachNode((n, a) => {
      if (placed.has(n)) all.push(a);
    });
    if (known.length > 0) {
      const counts = new Map<string, number>();
      for (const n of known) {
        const c = graph.getNodeAttribute(n, 'community');
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      let community = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (community === ISOLATED) {
        community = `live${nextId++}`;
        for (const n of known) if (graph.getNodeAttribute(n, 'community') === ISOLATED) graph.setNodeAttribute(n, 'community', community);
      }
      graph.mergeNodeAttributes(id, { community, ...placeNear(graph.getNodeAttributes(known[0]), all, rng) });
    } else if (graph.degree(id) > 0) {
      let maxX = 0;
      let minY = 0;
      let maxY = 0;
      for (const p of all) {
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      graph.mergeNodeAttributes(id, { community: `live${nextId++}`, x: all.length ? maxX + 160 : 0, y: (minY + maxY) / 2 });
    } else {
      const grid = all.length
        ? graph.filterNodes((n, a) => placed.has(n) && a.community === ISOLATED).map((n) => graph.getNodeAttributes(n))
        : [];
      let spot: Point = nextGridSpot(grid);
      if (grid.length === 0 && all.length > 0) {
        // No isolated grid yet: start one below everything.
        spot = { x: Math.min(...all.map((p) => p.x)), y: Math.max(...all.map((p) => p.y)) + 120 };
      }
      graph.mergeNodeAttributes(id, { community: ISOLATED, ...spot });
    }
    placed.add(id);
  }
}

/** Every concept ever explored, across conversations (D2), as a WebGL graph grouped by topic. */
const RELATION_COLOR = '#f59e0b';
/** Superclass links (concept to its group): a hue of their own, so they read apart from drill-downs and free relations. */
const SUPER_COLOR = '#8b5cf6';

export function PersonalView({ live, found, onOpenConcept, onBackgroundClick, focusId = null, onHoverConcept }: Props) {
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const hoverCallback = useRef(onHoverConcept);
  hoverCallback.current = onHoverConcept;
  const backgroundClick = useRef(onBackgroundClick);
  backgroundClick.current = onBackgroundClick;
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef(new Graph<NodeAttrs>());
  const sigmaRef = useRef<Sigma<NodeAttrs> | null>(null);
  const hoverRef = useRef<string | null>(null);
  /** Dragging a concept: the one in hand, and the superclass under it (where dropping it groups it). */
  const dragRef = useRef<{ node: string; x: number; y: number; moved: boolean } | null>(null);
  const dropRef = useRef<string | null>(null);
  const justDragged = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The edge under the pointer: drawn on top with its label, nodes covering it fade. */
  const edgeHoverRef = useRef<string | null>(null);
  const foundRef = useRef<string | null>(null);
  const rngRef = useRef(seeded(9));
  const relayoutRef = useRef(true);
  const communitySlots = useRef(new Map<string, number>());
  const conversationSlots = useRef(new Map<string, number>());
  const conversations = useRef(new Map<string, string>());
  /** What the reducers and the overlay read; React state mirrors it for the toolbar and legend. */
  const view = useRef({
    colorBy: 'community' as ColorBy,
    visible: null as Set<string> | null,
    focus: null as string | null,
    overview: false,
    bubbles: [] as Bubble[],
    pointer: null as Point | null,
    /** Node size cap at the full view: big graphs are dense, their nodes start as dots and grow with the zoom. */
    maxSize: Infinity,
  });
  const [count, setCount] = useState<number | null>(null);
  const [shown, setShown] = useState(0);
  const [colorBy, setColorBy] = useState<ColorBy>(() =>
    stored<string>('kg.personal.colorBy', 'community') === 'conversation' ? 'conversation' : 'community',
  );
  const [conversation, setConversation] = useState('');
  const [period, setPeriod] = useState('');
  const [hideIsolated, setHideIsolated] = useState(() => stored<boolean>('kg.personal.hideIsolated', false));
  const [withSources, setWithSources] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [legend, setLegend] = useState<Group[]>([]);
  const [legendOpen, setLegendOpen] = useState(() => !isMobile() && stored<boolean>('kg.personal.legend', true));
  // Phone: the toolbar folds into one row with a "Filtri" button.
  const mobile = useMobile();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [conversationList, setConversationList] = useState<{ id: string; title: string }[]>([]);
  const [overview, setOverview] = useState(false);
  const [version, setVersion] = useState(0);
  const [reload, setReload] = useState(0);

  const palette = useCallback(() => {
    const colors = Array.from({ length: SLOTS }, (_, i) => cssVar(`--series-${i + 1}`));
    return { colors, other: cssVar('--series-other') };
  }, []);

  /** The group key a node belongs to in the current colouring: drives colour, legend and focus. */
  const groupOf = useCallback((node: string, a: NodeAttrs): { key: string; slot: number } => {
    if (view.current.colorBy === 'conversation') {
      const conv = a.conversationIds[0] ?? '';
      const slot = conversationSlots.current.get(conv) ?? -1;
      return { key: slot >= 0 ? `v:${conv}` : 'v:other', slot };
    }
    if (a.community === ISOLATED) return { key: 'isolated', slot: -1 };
    const slot = communitySlots.current.get(a.community) ?? -1;
    return { key: slot >= 0 ? `c:${a.community}` : 'c:other', slot };
  }, []);

  // Sigma is created once; data and filter updates mutate refs and ask Sigma to redraw.
  useEffect(() => {
    const graph = graphRef.current;
    const { colors, other } = palette();
    const text = cssVar('--text');
    const bg = cssVar('--bg');
    const surface = cssVar('--surface');
    const muted = cssVar('--muted');
    const faded = cssVar('--border');
    const labelFont = 'system-ui, sans-serif';
    const pending: { x: number; y: number; size: number; links: number; label: string; forced: boolean; must: boolean }[] = [];

    // Labels are collected here and drawn after the frame, biggest (or nearest the pointer) first,
    // skipping any that would overlap one already drawn.
    const collect: NodeLabelDrawingFunction<NodeAttrs> = (_ctx, d) => {
      if (d.label) {
        const links = typeof d.key === 'string' && graph.hasNode(d.key) ? graph.degree(d.key) : 0;
        pending.push({ x: d.x, y: d.y, size: d.size, links, label: d.label, forced: !!d.forceLabel, must: !!d.highlighted });
      }
    };
    const drawHover: NodeLabelDrawingFunction<NodeAttrs> = (ctx, d) => {
      ctx.font = `600 13px ${labelFont}`;
      const w = d.label ? ctx.measureText(d.label).width : 0;
      ctx.fillStyle = surface;
      ctx.shadowColor = 'rgb(0 0 0 / 0.25)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size + 3, 0, Math.PI * 2);
      ctx.fill();
      if (d.label) {
        ctx.beginPath();
        ctx.roundRect(d.x + d.size + 2, d.y - 11, w + 12, 22, 6);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
      ctx.fill();
      if (d.label) {
        ctx.fillStyle = text;
        ctx.fillText(d.label, d.x + d.size + 8, d.y + 4.5);
      }
    };

    const renderer = new Sigma(graph, container.current!, {
      labelColor: { color: text },
      renderEdgeLabels: true,
      edgeLabelSize: 11,
      edgeLabelColor: { color: text },
      defaultEdgeColor: cssVar('--edge'),
      labelFont,
      labelSize: 13,
      labelWeight: '500',
      // The grid only proposes candidates; the pass after the frame removes collisions.
      labelDensity: 2.5,
      labelGridCellSize: 90,
      // Room for the community bubbles around the outermost concepts.
      stagePadding: 60,
      labelRenderedSizeThreshold: 0,
      defaultDrawNodeLabel: collect,
      defaultDrawNodeHover: drawHover,
      hideEdgesOnMove: graph.order > 3000,
      zIndex: true,
      enableEdgeEvents: true,
      nodeReducer: (node, data) => {
        const v = view.current;
        const h = hoverRef.current;
        const isFound = node === foundRef.current;
        if (v.visible && !v.visible.has(node) && !isFound) return { ...data, hidden: true };
        const g = groupOf(node, data);
        const color = g.slot >= 0 ? colors[g.slot] : other;
        // The superclass a dragged concept would join: it grows and takes the superclass colour.
        if (node === dropRef.current) return { ...data, size: Math.min(data.size, v.maxSize) * 1.35, color: SUPER_COLOR, highlighted: true, zIndex: 3, forceLabel: true };
        const highlighted = node === h || isFound;
        const eh = edgeHoverRef.current;
        if (eh && !h && !isFound && sigmaRef.current && graph.hasEdge(eh) && !graph.hasExtremity(eh, node)) {
          // A node sitting on the hovered edge fades so the edge and its label can be read.
          const r = sigmaRef.current;
          const [s, t] = graph.extremities(eh);
          const a = r.graphToViewport(graph.getNodeAttributes(s) as { x: number; y: number });
          const b = r.graphToViewport(graph.getNodeAttributes(t) as { x: number; y: number });
          const p = r.graphToViewport(data as { x: number; y: number });
          const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
          const u = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
          const dist = Math.hypot(p.x - (a.x + u * (b.x - a.x)), p.y - (a.y + u * (b.y - a.y)));
          if (dist <= r.scaleSize(Math.min(data.size, v.maxSize)) + 2) return { ...data, size: Math.min(data.size, v.maxSize), color: faded, label: '', zIndex: 0 };
        }
        const dim = h ? node !== h && !graph.areNeighbors(node, h) : v.focus ? g.key !== v.focus && !isFound : false;
        if (dim) return { ...data, size: Math.min(data.size, v.maxSize), color: faded, label: '', zIndex: 0 };
        return { ...data, size: Math.min(data.size, v.maxSize), color, highlighted, zIndex: 1, forceLabel: !!h || isFound || !!data.isSuper || graph.order <= SMALL_GRAPH };
      },
      edgeReducer: (edge, data) => {
        const v = view.current;
        const h = hoverRef.current;
        const [s, t] = graph.extremities(edge);
        if (v.visible && (!v.visible.has(s) || !v.visible.has(t))) return { ...data, hidden: true };
        if (edge === edgeHoverRef.current && !h) return { ...data, color: RELATION_COLOR, size: Math.max(data.size as number, 1.6) + 2, forceLabel: true, zIndex: 10 };
        if (h)
          return graph.hasExtremity(edge, h) ? { ...data, color: muted, size: (data.size as number) + 0.5 } : { ...data, hidden: true };
        if (v.focus) {
          const a = graph.getNodeAttributes(s);
          const b = graph.getNodeAttributes(t);
          if (groupOf(s, a).key !== v.focus || groupOf(t, b).key !== v.focus) return { ...data, hidden: true };
        }
        if (graph.getEdgeAttribute(edge, 'isa')) return { ...data, color: SUPER_COLOR, size: Math.max(data.size as number, 1.6) };
        // Free relations drawn by the user keep their own colour, also across topics.
        if (graph.getEdgeAttribute(edge, 'relation')) return { ...data, color: RELATION_COLOR, size: Math.max(data.size as number, 1.6) };
        // Links across topics stay faint, so the communities read as separate groups.
        if (graph.getNodeAttribute(s, 'community') !== graph.getNodeAttribute(t, 'community')) return { ...data, color: faded };
        return data;
      },
    });
    sigmaRef.current = renderer;

    const bubbleCanvas = renderer.createCanvas('bubbles', { beforeLayer: 'edges' });
    const bubbleCtx = bubbleCanvas.getContext('2d')!;
    const labelCtx = renderer.getCanvases().labels.getContext('2d')!;

    const viewportBubble = (b: Bubble) => {
      const c = renderer.graphToViewport(b);
      const e = renderer.graphToViewport({ x: b.x + b.r, y: b.y });
      return { x: c.x, y: c.y, r: Math.hypot(e.x - c.x, e.y - c.y) };
    };

    const draw = () => {
      const v = view.current;
      const { width, height } = renderer.getDimensions();
      // How many visible concepts are on screen decides the level: communities or concepts.
      let onScreen = 0;
      // Discs of the concepts on screen, for the label pass below.
      const discs: { x: number; y: number; r: number; links: number }[] = [];
      graph.forEachNode((n) => {
        if (v.visible && !v.visible.has(n)) return;
        const d = renderer.getNodeDisplayData(n);
        if (!d || d.hidden) return;
        const p = renderer.framedGraphToViewport(d);
        if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) {
          onScreen++;
          discs.push({ x: p.x, y: p.y, r: renderer.scaleSize(d.size), links: graph.degree(n) });
        }
      });
      const isOverview = onScreen > LABEL_BUDGET && v.bubbles.length > 0;
      if (isOverview !== v.overview) {
        v.overview = isOverview;
        setOverview(isOverview);
      }

      // Bubbles, under the edges.
      const dpr = window.devicePixelRatio || 1;
      if (bubbleCanvas.width !== Math.round(width * dpr) || bubbleCanvas.height !== Math.round(height * dpr)) {
        bubbleCanvas.width = Math.round(width * dpr);
        bubbleCanvas.height = Math.round(height * dpr);
        bubbleCanvas.style.width = `${width}px`;
        bubbleCanvas.style.height = `${height}px`;
      }
      bubbleCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bubbleCtx.clearRect(0, 0, width, height);
      // Hovering a concept lights its bubble and those of its linked concepts; the rest recedes.
      const hovered = hoverRef.current;
      let lit: Set<string> | null = null;
      if (hovered && graph.hasNode(hovered)) {
        lit = new Set([graph.getNodeAttribute(hovered, 'community')]);
        graph.forEachNeighbor(hovered, (n) => lit!.add(graph.getNodeAttribute(n, 'community')));
      }
      for (const b of v.bubbles) {
        const p = viewportBubble(b);
        if (lit) {
          const on = lit.has(b.id);
          const color = b.slot >= 0 && v.colorBy === 'community' ? colors[b.slot] : muted;
          bubbleCtx.globalAlpha = on ? 0.16 : 0.015;
          bubbleCtx.fillStyle = color;
          bubbleCtx.beginPath();
          bubbleCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          bubbleCtx.fill();
          if (on) {
            bubbleCtx.globalAlpha = 0.5;
            bubbleCtx.strokeStyle = color;
            bubbleCtx.lineWidth = 1.5;
            bubbleCtx.stroke();
          }
          continue;
        }
        const dim = v.focus && !(b.slot >= 0 ? v.focus === `c:${b.id}` : false) && v.colorBy === 'community';
        const neutral = v.colorBy !== 'community' || b.slot < 0;
        const color = neutral ? muted : colors[b.slot];
        bubbleCtx.globalAlpha = dim ? 0.03 : isOverview ? (neutral ? 0.08 : 0.13) : 0.05;
        bubbleCtx.fillStyle = color;
        bubbleCtx.beginPath();
        bubbleCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        bubbleCtx.fill();
        if (isOverview && !dim) {
          bubbleCtx.globalAlpha = 0.45;
          bubbleCtx.strokeStyle = color;
          bubbleCtx.lineWidth = 1.5;
          bubbleCtx.stroke();
        }
      }
      bubbleCtx.globalAlpha = 1;

      // Labels, after Sigma's own pass (which only collected them).
      const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
      const free = (r: { x0: number; y0: number; x1: number; y1: number }) =>
        taken.every((t) => r.x1 < t.x0 || r.x0 > t.x1 || r.y1 < t.y0 || r.y0 > t.y1);
      const halo = (label: string, x: number, y: number) => {
        labelCtx.strokeText(label, x, y);
        labelCtx.fillText(label, x, y);
      };
      labelCtx.lineJoin = 'round';
      labelCtx.strokeStyle = bg;
      labelCtx.lineWidth = 3;
      labelCtx.fillStyle = text;

      if (isOverview) {
        const ranked = v.bubbles.map((b) => ({ b, p: viewportBubble(b) })).sort((a, b) => b.b.count - a.b.count);
        for (const { b, p } of ranked) {
          if (p.x < -50 || p.x > width + 50 || p.y < -50 || p.y > height + 50) continue;
          const size = Math.round(Math.min(18, Math.max(12, 10 + p.r / 18)));
          labelCtx.font = `600 ${size}px ${labelFont}`;
          const w = labelCtx.measureText(b.name).width;
          const sub = plural(b.count, 'concetto', 'concetti');
          const box = { x0: p.x - w / 2 - 4, y0: p.y - size - 4, x1: p.x + w / 2 + 4, y1: p.y + 18 };
          if (!free(box)) continue;
          taken.push(box);
          labelCtx.fillStyle = text;
          labelCtx.textAlign = 'center';
          halo(b.name, p.x, p.y);
          labelCtx.font = `400 12px ${labelFont}`;
          labelCtx.fillStyle = muted;
          halo(sub, p.x, p.y + 15);
        }
        labelCtx.textAlign = 'left';
      }

      const pointer = v.pointer;
      const near = (l: { x: number; y: number }) => (pointer ? Math.hypot(l.x - pointer.x, l.y - pointer.y) : Infinity);
      const small = graph.order <= SMALL_GRAPH;
      const candidates = pending
        .filter((l) => l.forced || !isOverview || small)
        .sort((a, b) => {
          if (a.must !== b.must) return a.must ? -1 : 1;
          if (a.forced !== b.forced) return a.forced ? -1 : 1;
          const na = near(a) < 120;
          const nb = near(b) < 120;
          if (na !== nb) return na ? -1 : 1;
          return b.size - a.size || b.links - a.links;
        });
      // A label may run over smaller or less linked dots (a hub over its spokes), not over a peer's dot.
      const covers = (b: { x0: number; y0: number; x1: number; y1: number }, own: { x: number; y: number; size: number; links: number }) =>
        discs.some(
          (c) =>
            c.r >= own.size * 0.9 &&
            c.links >= own.links &&
            (Math.abs(c.x - own.x) > 0.5 || Math.abs(c.y - own.y) > 0.5) &&
            Math.hypot(c.x - Math.max(b.x0, Math.min(c.x, b.x1)), c.y - Math.max(b.y0, Math.min(c.y, b.y1))) < c.r * 0.6,
        );
      labelCtx.font = `500 13px ${labelFont}`;
      labelCtx.fillStyle = text;
      for (const l of candidates) {
        if (l.x < -100 || l.x > width + 20 || l.y < -20 || l.y > height + 20) continue;
        const w = labelCtx.measureText(l.label).width;
        let x = l.x + l.size + 4;
        let y = l.y;
        let box = { x0: x - 2, y0: y - 9, x1: x + w + 2, y1: y + 9 };
        if (small && !l.must) {
          // Few concepts: try right, left, below, above; if all are taken, draw it on the right anyway.
          const tries = [
            { x, y },
            { x: l.x - l.size - 4 - w, y },
            { x: l.x - w / 2, y: l.y + l.size + 14 },
            { x: l.x - w / 2, y: l.y - l.size - 8 },
          ];
          const spot = tries.find((t) => free({ x0: t.x - 2, y0: t.y - 9, x1: t.x + w + 2, y1: t.y + 9 })) ?? tries[0];
          ({ x, y } = spot);
          box = { x0: x - 2, y0: y - 9, x1: x + w + 2, y1: y + 9 };
        } else if (!l.must && (!free(box) || covers(box, l))) continue;
        taken.push(box);
        halo(l.label, x, y + 4.5);
      }
      pending.length = 0;
    };
    renderer.on('beforeRender', () => {
      pending.length = 0;
    });
    renderer.on('afterRender', draw);

    // Hover mode: the highlight and the panel follow the node under the pointer; in focus mode they stay put.
    renderer.on('enterNode', ({ node }) => {
      if (focusRef.current || dragRef.current) return;
      hoverRef.current = node;
      hoverCallback.current?.(node);
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('leaveNode', () => {
      if (focusRef.current || dragRef.current) return;
      hoverRef.current = null;
      hoverCallback.current?.(null);
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('enterEdge', ({ edge }) => {
      if (focusRef.current || hoverRef.current) return;
      edgeHoverRef.current = edge;
      renderer.refresh({ skipIndexation: true });
    });
    renderer.on('leaveEdge', () => {
      if (!edgeHoverRef.current) return;
      edgeHoverRef.current = null;
      renderer.refresh({ skipIndexation: true });
    });
    // Drag a concept: it follows the pointer; dropped on a superclass it becomes one of its members (D18).
    // Elsewhere it simply stays where it was dropped, until the graph is laid out again.
    const superUnder = (x: number, y: number, except: string): string | null => {
      let best: string | null = null;
      let bestDist = Infinity;
      graph.forEachNode((n, a) => {
        if (n === except || !a.isSuper || (view.current.visible && !view.current.visible.has(n))) return;
        const d = renderer.getNodeDisplayData(n);
        if (!d || d.hidden) return;
        const p = renderer.framedGraphToViewport(d);
        const dist = Math.hypot(p.x - x, p.y - y);
        if (dist <= renderer.scaleSize(Math.min(d.size, view.current.maxSize)) + 10 && dist < bestDist) [best, bestDist] = [n, dist];
      });
      return best;
    };
    renderer.on('downNode', ({ node, event }) => {
      dragRef.current = { node, x: event.x, y: event.y, moved: false };
      // No text selection while carrying a concept; the camera does not pan.
      event.original.preventDefault();
      event.preventSigmaDefault();
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
    });
    renderer.getMouseCaptor().on('mousemovebody', (event) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.moved && Math.hypot(event.x - drag.x, event.y - drag.y) < 5) return;
      drag.moved = true;
      const pos = renderer.viewportToGraph(event);
      graph.mergeNodeAttributes(drag.node, { x: pos.x, y: pos.y });
      dropRef.current = superUnder(event.x, event.y, drag.node);
      container.current!.style.cursor = dropRef.current ? 'copy' : 'grabbing';
      // The pointer is carrying a concept: the camera stays put.
      event.preventSigmaDefault();
      event.original.preventDefault();
      event.original.stopPropagation();
      renderer.refresh({ skipIndexation: false });
    });
    renderer.getMouseCaptor().on('mouseup', () => {
      const drag = dragRef.current;
      if (!drag) return;
      const target = dropRef.current;
      dragRef.current = null;
      dropRef.current = null;
      container.current!.style.cursor = '';
      if (!drag.moved) return;
      // The click that follows a drag must not open the panel.
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 100);
      renderer.refresh({ skipIndexation: true });
      if (target) {
        setNotice(null);
        // Same operation as "Raggruppa in…" and kc_relate with a superclass; the live event lays the groups out again.
        api.setSuperclass(drag.node, target).catch((e: Error) => setNotice(explain(e.message)));
      }
    });
    renderer.on('clickNode', ({ node, event }) => {
      if (justDragged.current) return;
      // From afar a node is a dot inside its community: the click zooms in rather than opening it.
      const b = bubbleAt(event.x, event.y);
      if (b) zoomToBubble(b);
      else onOpenConcept(node);
    });
    // From afar a click on a community zooms into it.
    const bubbleAt = (x: number, y: number) =>
      view.current.overview
        ? view.current.bubbles.find((b) => {
            const p = viewportBubble(b);
            return Math.hypot(p.x - x, p.y - y) <= p.r;
          })
        : undefined;
    renderer.on('clickStage', ({ event }) => {
      const b = bubbleAt(event.x, event.y);
      if (b) zoomToBubble(b);
      else backgroundClick.current?.();
    });
    renderer.on('moveBody', ({ event }) => {
      view.current.pointer = { x: event.x, y: event.y };
      container.current!.style.cursor = bubbleAt(event.x, event.y) ? 'zoom-in' : '';
      if (!view.current.overview) renderer.scheduleRender();
    });
    const zoomToBubble = (b: Bubble) => {
      const p = viewportBubble(b);
      const { width, height } = renderer.getDimensions();
      const camera = renderer.getCamera();
      const target = renderer.viewportToFramedGraph(p);
      const ratio = camera.getState().ratio * Math.min(1, (p.r * 2 * 1.15) / Math.min(width, height));
      void camera.animate({ x: target.x, y: target.y, ratio }, { duration: 450 });
    };
    // Lets end-to-end tests find concepts and communities on screen; WebGL draws nothing in the DOM.
    (window as unknown as { __kgPersonal?: unknown }).__kgPersonal = {
      position: (label: string) => {
        const id = graph.findNode((_, a) => a.label === label);
        const d = id ? renderer.getNodeDisplayData(id) : undefined;
        return d && !d.hidden ? renderer.framedGraphToViewport(d) : null;
      },
      bubbles: () => view.current.bubbles.map((b) => ({ name: b.name, count: b.count, ...viewportBubble(b) })),
      community: (label: string) => {
        const id = graph.findNode((_, a) => a.label === label);
        return id ? graph.getNodeAttribute(id, 'community') : null;
      },
      ratio: () => renderer.getCamera().getState().ratio,
      /** The concept in hand and the superclass it would join if dropped now. */
      drag: () => ({ node: dragRef.current ? graph.getNodeAttribute(dragRef.current.node, 'label') : null, over: dropRef.current ? graph.getNodeAttribute(dropRef.current, 'label') : null }),
    };
    return () => {
      renderer.kill();
      sigmaRef.current = null;
    };
  }, [onOpenConcept, groupOf, palette]);

  /** Recomputes visibility, colour slots, legend and bubbles from the graph and the filters. */
  const recompute = useCallback(
    (fit: boolean) => {
      const graph = graphRef.current;
      const v = view.current;
      v.colorBy = colorBy;
      v.focus = focus;
      const since = period ? Date.now() - Number(period) * DAY_MS : null;
      const filtered = conversation !== '' || since !== null || hideIsolated || withSources;
      const visible = new Set<string>();
      graph.forEachNode((n, a) => {
        if (conversation && !a.conversationIds.includes(conversation)) return;
        if (since !== null && Date.parse(a.lastSeenAt) < since) return;
        if (hideIsolated && graph.degree(n) === 0) return;
        if (withSources && a.sourceCount === 0) return;
        visible.add(n);
      });
      v.visible = filtered ? visible : null;

      // Colour slots: communities and conversations keep theirs once given.
      const communitySizes = new Map<string, number>();
      const conversationSizes = new Map<string, number>();
      graph.forEachNode((_, a) => {
        if (a.community !== ISOLATED) communitySizes.set(a.community, (communitySizes.get(a.community) ?? 0) + 1);
        const conv = a.conversationIds[0];
        if (conv) conversationSizes.set(conv, (conversationSizes.get(conv) ?? 0) + 1);
      });
      // Communities too small for a colour stay grey even when slots are free.
      for (const [k, size] of communitySizes) if (size < MIN_BUBBLE) communitySizes.delete(k);
      assignSlots(communitySlots.current, communitySizes);
      assignSlots(conversationSlots.current, conversationSizes);

      // Legend and bubbles from the visible concepts only.
      const groups = new Map<string, Group>();
      const members = new Map<string, string[]>();
      for (const n of visible) {
        const a = graph.getNodeAttributes(n);
        const { key, slot } = groupOf(n, a);
        const entry = groups.get(key) ?? { key, name: '', count: 0, slot };
        entry.count++;
        groups.set(key, entry);
        if (!members.has(a.community)) members.set(a.community, []);
        members.get(a.community)!.push(n);
      }
      // A community is named after its hub (most links inside it), whatever the filters show.
      const everyone = new Map<string, string[]>();
      graph.forEachNode((n, a) => {
        if (!everyone.has(a.community)) everyone.set(a.community, []);
        everyone.get(a.community)!.push(n);
      });
      const names = new Map<string, string>();
      const nameOfCommunity = (c: string) => {
        if (c.startsWith('s:') && graph.hasNode(c.slice(2))) return graph.getNodeAttribute(c.slice(2), 'label');
        if (!names.has(c)) {
          const inside = (n: string) => graph.filterNeighbors(n, (_, a) => a.community === c).length;
          let best = '';
          let bestScore = [-1, -1];
          for (const n of everyone.get(c) ?? []) {
            const score = [inside(n), graph.getNodeAttribute(n, 'visitCount')];
            if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) [best, bestScore] = [n, score];
          }
          names.set(c, best ? graph.getNodeAttribute(best, 'label') : '');
        }
        return names.get(c)!;
      };
      for (const g of groups.values()) {
        if (g.key === 'isolated') g.name = 'Concetti isolati';
        else if (g.key === 'c:other') g.name = 'Altre comunità';
        else if (g.key === 'v:other') g.name = 'Altri grafi';
        else if (g.key.startsWith('c:')) g.name = nameOfCommunity(g.key.slice(2));
        else g.name = conversations.current.get(g.key.slice(2)) ?? 'Grafo';
      }
      const order = (g: Group) => (g.slot >= 0 ? 0 : g.key === 'isolated' ? 2 : 1);
      setLegend([...groups.values()].sort((a, b) => order(a) - order(b) || b.count - a.count));

      const bubbles: Bubble[] = [];
      for (const [c, list] of members) {
        if (list.length < MIN_BUBBLE) continue;
        let x = 0;
        let y = 0;
        for (const n of list) {
          x += graph.getNodeAttribute(n, 'x');
          y += graph.getNodeAttribute(n, 'y');
        }
        x /= list.length;
        y /= list.length;
        let r = 0;
        for (const n of list) r = Math.max(r, Math.hypot(graph.getNodeAttribute(n, 'x') - x, graph.getNodeAttribute(n, 'y') - y));
        bubbles.push({
          id: c,
          name: c === ISOLATED ? 'Concetti isolati' : nameOfCommunity(c),
          count: list.length,
          slot: c === ISOLATED ? -1 : (communitySlots.current.get(c) ?? -1),
          x,
          y,
          r: r + 20,
        });
      }
      v.bubbles = bubbles;
      setShown(visible.size);

      const renderer = sigmaRef.current;
      if (!renderer) return;
      renderer.refresh();
      if (fit) fitVisible(renderer, graph, v.visible);
    },
    [colorBy, conversation, period, hideIsolated, withSources, focus, groupOf],
  );

  // Load on mount and on every live change.
  useEffect(() => {
    let cancelled = false;
    api.graph().then((data) => {
      if (cancelled) return;
      const graph = graphRef.current;
      const relayout = relayoutRef.current || graph.order === 0;
      relayoutRef.current = false;
      conversations.current = new Map(data.conversations.map((c) => [c.id, c.title]));
      setConversationList(data.conversations);
      merge(graph, data, relayout, rngRef.current);
      if (relayout) communitySlots.current.clear();
      // At the full view a node may not be wider than about a third of a link, or a dense graph turns into blobs.
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      graph.forEachNode((_, a) => {
        x0 = Math.min(x0, a.x);
        y0 = Math.min(y0, a.y);
        x1 = Math.max(x1, a.x);
        y1 = Math.max(y1, a.y);
      });
      const screen = Math.min(container.current?.clientWidth || 800, container.current?.clientHeight || 600);
      view.current.maxSize = graph.order > 1 ? Math.max(1.5, (screen / Math.max(x1 - x0, y1 - y0, 1)) * 14) : Infinity;
      // The searched concept was deleted or merged: zoom back out instead of staring at an empty spot.
      if (foundRef.current && !graph.hasNode(foundRef.current)) {
        foundRef.current = null;
        void sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
      }
      setCount(graph.order);
      setVersion((x) => x + 1);
      sigmaRef.current?.setSetting('hideEdgesOnMove', graph.order > 3000);
      if (relayout) void sigmaRef.current?.getCamera().animatedReset({ duration: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [live, reload]);

  // Filters fit the camera to what is left; colouring and live data do not move it.
  const lastFilters = useRef('');
  useEffect(() => {
    const key = `${conversation}|${period}|${hideIsolated}|${withSources}`;
    const fit = lastFilters.current !== '' && key !== lastFilters.current;
    lastFilters.current = key;
    recompute(fit);
  }, [recompute, version, conversation, period, hideIsolated, withSources]);

  // The concept picked in the search is highlighted and centred, close enough to read its neighbours.
  useEffect(() => {
    const renderer = sigmaRef.current;
    foundRef.current = found?.conceptId ?? null;
    if (!renderer || !found) return;
    renderer.refresh({ skipIndexation: true });
    const d = renderer.getNodeDisplayData(found.conceptId);
    const ratio = Math.min(0.4, Math.max(0.03, Math.sqrt(60 / Math.max(1, graphRef.current.order))));
    if (d) void renderer.getCamera().animate({ x: d.x, y: d.y, ratio }, { duration: 400 });
  }, [found]);

  // Focus mode highlights the locked node with its relations; leaving it returns to hover mode.
  useEffect(() => {
    hoverRef.current = focusId && graphRef.current.hasNode(focusId) ? focusId : null;
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [focusId]);

  const filtered = conversation !== '' || period !== '' || hideIsolated || withSources;
  const camera = () => sigmaRef.current?.getCamera();

  return (
    <div className="personal-view">
      {count !== null && count > 0 && (
        <div className={`graph-tools${mobile && !filtersOpen ? ' folded' : ''}`}>
          <span className="muted small keep" data-testid="concept-count">
            {filtered ? `${shown} di ${plural(count, 'concetto', 'concetti')}` : plural(count, 'concetto', 'concetti')}
          </span>
          {mobile && (
            <button type="button" className="secondary keep tools-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
              Filtri{filtered ? ' •' : ''} {filtersOpen ? '▾' : '▸'}
            </button>
          )}
          <label className="tool">
            Colore
            <select
              aria-label="Colora per"
              value={colorBy}
              onChange={(e) => {
                const v = e.target.value as ColorBy;
                setColorBy(v);
                setFocus(null);
                store('kg.personal.colorBy', v);
              }}
            >
              <option value="community">per comunità</option>
              <option value="conversation">per grafo</option>
            </select>
          </label>
          <select aria-label="Filtra grafo" value={conversation} onChange={(e) => setConversation(e.target.value)}>
            <option value="">Tutti i grafi</option>
            {conversationList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select aria-label="Periodo" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <label className="tool">
            <input
              type="checkbox"
              checked={hideIsolated}
              onChange={(e) => {
                setHideIsolated(e.target.checked);
                store('kg.personal.hideIsolated', e.target.checked);
              }}
            />
            Nascondi isolati
          </label>
          <label className="tool">
            <input type="checkbox" checked={withSources} onChange={(e) => setWithSources(e.target.checked)} />
            Solo concetti con fonti
          </label>
          <button
            type="button"
            className="secondary"
            title="Ricalcola comunità e disposizione"
            onClick={() => {
              relayoutRef.current = true;
              setFocus(null);
              setReload((x) => x + 1);
            }}
          >
            Riordina
          </button>
          <GroupSuggestions live={live} />
        </div>
      )}
      <div className="graph-area">
        <div ref={container} className="sigma" data-testid="personal-graph" data-level={overview ? 'overview' : 'detail'} />
        {notice && (
          <p className="error graph-notice" role="alert">
            {notice}{' '}
            <button type="button" className="ghost icon" aria-label="Chiudi avviso" onClick={() => setNotice(null)}>
              ✕
            </button>
          </p>
        )}
        {count === 0 && (
          <div className="empty">
            <p>Il grafo globale è vuoto.</p>
            <p className="muted">Ogni concetto esplorato in un grafo comparirà qui.</p>
          </div>
        )}
        {count !== null && count > 0 && legend.length > 0 && (
          <div className="legend">
            <button
              type="button"
              className="legend-toggle"
              aria-expanded={legendOpen}
              onClick={() => {
                setLegendOpen(!legendOpen);
                if (!isMobile()) store('kg.personal.legend', !legendOpen);
              }}
            >
              {colorBy === 'community' ? 'Comunità' : 'Grafi'} <span aria-hidden="true">{legendOpen ? '▾' : '▸'}</span>
            </button>
            {legendOpen && (
              <ul aria-label="Legenda">
                {legend.map((g) => (
                  <li key={g.key}>
                    <button
                      type="button"
                      aria-pressed={focus === g.key}
                      className={focus && focus !== g.key ? 'dimmed' : ''}
                      title={focus === g.key ? 'Mostra tutti' : 'Evidenzia questo gruppo'}
                      onClick={() => {
                        const next = focus === g.key ? null : g.key;
                        setFocus(next);
                        const renderer = sigmaRef.current;
                        if (!renderer) return;
                        if (!next) return void camera()?.animatedReset({ duration: 300 });
                        const nodes = new Set<string>();
                        graphRef.current.forEachNode((n, a) => {
                          if ((!view.current.visible || view.current.visible.has(n)) && groupOf(n, a).key === next) nodes.add(n);
                        });
                        fitVisible(renderer, graphRef.current, nodes);
                      }}
                    >
                      <span
                        className="swatch"
                        style={{ background: g.slot >= 0 ? `var(--series-${g.slot + 1})` : 'var(--series-other)' }}
                      />
                      <span className="legend-name">{g.name}</span>
                      <span className="muted">{g.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {count !== null && count > 0 && (
          <div className="zoom-controls" role="group" aria-label="Zoom">
            <button type="button" className="icon" aria-label="Avvicina" onClick={() => void camera()?.animatedZoom({ duration: 250 })}>
              +
            </button>
            <button type="button" className="icon" aria-label="Allontana" onClick={() => void camera()?.animatedUnzoom({ duration: 250 })}>
              −
            </button>
            <button
              type="button"
              className="icon"
              aria-label="Mostra tutto"
              onClick={() => {
                const r = sigmaRef.current;
                if (r) fitVisible(r, graphRef.current, view.current.visible);
              }}
            >
              ⤢
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Moves the camera so the given concepts (all of them when null) fill the screen. */
function fitVisible(renderer: Sigma<NodeAttrs>, graph: Graph<NodeAttrs>, nodes: Set<string> | null) {
  const camera = renderer.getCamera();
  if (!nodes) return void camera.animatedReset({ duration: 300 });
  if (nodes.size === 0) return;
  const box = (filter: (n: string) => boolean) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    graph.forEachNode((n) => {
      if (!filter(n)) return;
      const d = renderer.getNodeDisplayData(n);
      if (!d) return;
      x0 = Math.min(x0, d.x);
      y0 = Math.min(y0, d.y);
      x1 = Math.max(x1, d.x);
      y1 = Math.max(y1, d.y);
    });
    return { x0, y0, x1, y1 };
  };
  const all = box(() => true);
  const part = box((n) => nodes.has(n));
  const fw = Math.max(all.x1 - all.x0, 1e-6);
  const fh = Math.max(all.y1 - all.y0, 1e-6);
  const ratio = Math.min(1, Math.max(0.03, Math.max((part.x1 - part.x0) / fw, (part.y1 - part.y0) / fh) * 1.25));
  void camera.animate({ x: (part.x0 + part.x1) / 2, y: (part.y0 + part.y1) / 2, ratio }, { duration: 400 });
}
