import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Edge } from '@xyflow/react';
import { api, subscribe, type Conversation, type ConversationTree, type TrackerEvent } from './api.ts';
import { buildEdges, layout, type VisitNode as VisitNodeType } from './layout.ts';
import { VisitNode } from './VisitNode.tsx';
import { DetailPanel } from './DetailPanel.tsx';

const nodeTypes = { visit: VisitNode };
const FRESH_MS = 1600;
const AUTO = '';

function Canvas() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [pinned, setPinned] = useState<string>(AUTO);
  const [tree, setTree] = useState<ConversationTree | null>(null);
  const [nodes, setNodes] = useState<VisitNodeType[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [openConcept, setOpenConcept] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onHover = useCallback((id: string | null) => {
    clearTimeout(hoverTimer.current);
    if (id) setHovered(id);
    else hoverTimer.current = setTimeout(() => setHovered(null), 180);
  }, []);
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState(false);
  const flow = useReactFlow();
  const knownIds = useRef<Set<string>>(new Set());

  const activeId = pinned || conversations[0]?.id || null;

  const loadConversations = useCallback(() => api.conversations().then(setConversations), []);
  const loadTree = useCallback(() => {
    if (activeId) api.tree(activeId).then(setTree);
    else setTree(null);
  }, [activeId]);

  useEffect(() => void loadConversations(), [loadConversations]);
  useEffect(() => {
    knownIds.current = new Set();
    loadTree();
  }, [loadTree]);

  // Live updates: any change reloads the list and, when relevant, the open tree.
  useEffect(
    () =>
      subscribe(
        (e: TrackerEvent) => {
          void loadConversations();
          const conv = 'conversationId' in e ? e.conversationId : 'visit' in e ? e.visit.conversationId : null;
          if (conv === activeId) loadTree();
          setVersion((v) => v + 1);
        },
        setOnline,
      ),
    [activeId, loadConversations, loadTree],
  );

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
    void layout(tree.visits).then((pos) => {
      if (cancelled) return;
      setNodes(
        tree.visits.map((v) => ({
          id: v.id,
          type: 'visit',
          position: pos.get(v.id) ?? { x: 0, y: 0 },
          data: {
            visit: v,
            current: v.id === tree.conversation.currentVisitId,
            fresh: false,
            hovered: false,
            onHover,
            onOpen: setOpenConcept,
          },
        })),
      );
      setEdges(buildEdges(tree.visits));
      requestAnimationFrame(() => {
        const cur = tree.conversation.currentVisitId;
        if (firstLoad) void flow.fitView({ padding: 0.2, maxZoom: 1.2 });
        else if (cur) void flow.fitView({ nodes: [{ id: cur }], padding: 2, maxZoom: 1.2, duration: 400 });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [tree, flow, onHover]);

  const shown = useMemo(
    () =>
      nodes.map((n) =>
        fresh.has(n.id) || hovered === n.id
          ? { ...n, data: { ...n.data, fresh: fresh.has(n.id), hovered: hovered === n.id } }
          : n,
      ),
    [nodes, fresh, hovered],
  );

  return (
    <div className="app">
      <header className="bar">
        <strong>Knowledge Graph</strong>
        <select value={pinned} onChange={(e) => setPinned(e.target.value)} aria-label="Conversazione">
          <option value={AUTO}>Segui l'ultima conversazione</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title} · {new Date(c.startedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
            </option>
          ))}
        </select>
        <span className={`dot ${online ? 'on' : ''}`} title={online ? 'Collegato' : 'Non collegato'} />
      </header>
      <main>
        {tree && tree.visits.length > 0 ? (
          <ReactFlow
            nodes={shown}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
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
        {openConcept && <DetailPanel conceptId={openConcept} version={version} onClose={() => setOpenConcept(null)} />}
      </main>
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
