import { useCallback, useEffect, useRef, useState } from 'react';
import { READONLY, subscribe, type TrackerEvent } from './api.ts';
import { ConversationView } from './ConversationView.tsx';
import { MetricsView } from './MetricsView.tsx';
import { PersonalView } from './PersonalView.tsx';
import { DetailPanel } from './DetailPanel.tsx';
import { ConceptSearch } from './ConceptSearch.tsx';

/** A tracker event with a sequence number, so views can react to every change. */
export interface LiveEvent {
  seq: number;
  event: TrackerEvent;
}

/** A concept picked in the search; seq makes picking the same one twice move the view again. */
export interface Found {
  seq: number;
  conceptId: string;
  /** A text hit: the node to open, in its own map. */
  visitId?: string;
  conversationId?: string;
}

type View = 'conversation' | 'personal' | 'metrics';
/** Dwell before the hover panel opens, and how long it stays after the pointer leaves a node. */
const HOVER_OPEN_MS = 300;
const HOVER_CLOSE_MS = 400;

const viewFromHash = (): View => (READONLY ? 'conversation' : location.hash === '#personale' ? 'personal' : location.hash === '#metriche' ? 'metrics' : 'conversation');

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [live, setLive] = useState<LiveEvent | null>(null);
  const [online, setOnline] = useState(false);
  const [openConcept, setOpenConcept] = useState<string | null>(null);
  // The map the open concept was opened from (D22): its page leads with that map's occurrence. Null = the global page.
  const [openMap, setOpenMap] = useState<string | null>(null);
  const openConceptIn = useCallback((conceptId: string, conversationId?: string) => {
    setOpenConcept(conceptId);
    setOpenMap(conversationId ?? null);
  }, []);
  // Personal graph, hover mode: the panel follows the node under the pointer (`hoverConcept`) until a click
  // locks it (`openConcept`, focus mode). It opens after a short dwell and lingers on leaving, so crossing
  // empty space between nodes does not flash it.
  const [hoverConcept, setHoverConcept] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverShown = useRef<string | null>(null);
  hoverShown.current = hoverConcept;
  const onHoverConcept = useCallback((id: string | null) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoverConcept(id), id ? (hoverShown.current ? 0 : HOVER_OPEN_MS) : HOVER_CLOSE_MS);
  }, []);
  const holdHover = useCallback(() => clearTimeout(hoverTimer.current), []);
  // Leaves focus mode, and closes the panel until the next hover.
  const closeConcept = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setHoverConcept(null);
    setOpenConcept(null);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeConcept();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [closeConcept]);
  const [found, setFound] = useState<Found | null>(null);

  useEffect(() => subscribe((event) => setLive((prev) => ({ seq: (prev?.seq ?? 0) + 1, event })), setOnline), []);
  // The open concept follows corrections made elsewhere (another tab, or the model's kc_link).
  useEffect(() => {
    const e = live?.event;
    if (!e) return;
    if (e.type === 'concept.merged' && e.fromId === openConcept) setOpenConcept(e.into.id);
    if (e.type === 'concept.deleted' && e.conceptId === openConcept) setOpenConcept(null);
    if (e.type === 'conversation.deleted' && openConcept && e.removedConceptIds.includes(openConcept)) setOpenConcept(null);
    if ((e.type === 'visit.relinked' || e.type === 'visit.deleted') && e.removedConceptId === openConcept) {
      setOpenConcept(e.type === 'visit.relinked' ? e.concept.id : null);
    }
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHash = () => {
      setHoverConcept(null);
      setView(viewFromHash());
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const shown = openConcept ?? (view === 'personal' ? hoverConcept : null);

  const tab = (v: View, label: string, hash: string) => (
    <a href={hash} role="tab" aria-selected={view === v} className={view === v ? 'active' : ''}>
      {label}
    </a>
  );

  return (
    <div className="app">
      <header className="bar">
        <strong>Knowledge Graph</strong>
        <ConceptSearch
          label="Cerca concetti"
          placeholder="Cerca nei concetti e nei testi…"
          className="header-search"
          onPick={(c) => {
            openConceptIn(c.id);
            setFound((prev) => ({ seq: (prev?.seq ?? 0) + 1, conceptId: c.id }));
          }}
          onPickHit={(h) => {
            openConceptIn(h.conceptId, h.conversationId);
            setFound((prev) => ({ seq: (prev?.seq ?? 0) + 1, conceptId: h.conceptId, visitId: h.visitId, conversationId: h.conversationId }));
            if (view !== 'conversation') location.hash = '#conversazione';
          }}
        />
        {!READONLY && (
          <>
            <nav role="tablist" className="tabs">
              {tab('conversation', 'Grafo', '#conversazione')}
              {tab('personal', 'Grafo globale', '#personale')}
              {tab('metrics', 'Metriche', '#metriche')}
            </nav>
            <span className={`dot ${online ? 'on' : ''}`} title={online ? 'Collegato' : 'Non collegato'} />
          </>
        )}
      </header>
      <main>
        {view === 'metrics' ? (
          <MetricsView live={live} />
        ) : view === 'conversation' ? (
          <ConversationView live={live} found={found} onOpenConcept={openConceptIn} onBackgroundClick={closeConcept} />
        ) : (
          <PersonalView
            live={live}
            found={found}
            onOpenConcept={openConceptIn}
            onBackgroundClick={closeConcept}
            focusId={openConcept}
            onHoverConcept={onHoverConcept}
          />
        )}
        {shown && view !== 'metrics' && (
          <DetailPanel
            conceptId={shown}
            conversationId={view === 'conversation' && openConcept ? openMap : null}
            pinned={view === 'personal' && openConcept !== null}
            onPin={() => setOpenConcept(shown)}
            onPointer={(inside) => (inside ? holdHover() : openConcept === null && onHoverConcept(null))}
            version={live?.seq ?? 0}
            onClose={closeConcept}
            onOpen={setOpenConcept}
          />
        )}
      </main>
    </div>
  );
}
