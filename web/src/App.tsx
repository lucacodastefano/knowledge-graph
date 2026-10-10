import { useCallback, useEffect, useState } from 'react';
import { subscribe, type TrackerEvent } from './api.ts';
import { ConversationView } from './ConversationView.tsx';
import { PersonalView } from './PersonalView.tsx';
import { DetailPanel } from './DetailPanel.tsx';
import { ConceptSearch } from './ConceptSearch.tsx';
import { api } from './api.ts';

/** A tracker event with a sequence number, so views can react to every change. */
export interface LiveEvent {
  seq: number;
  event: TrackerEvent;
}

/** A concept picked in the search; seq makes picking the same one twice move the view again. */
export interface Found {
  seq: number;
  conceptId: string;
}

type View = 'conversation' | 'personal';
const viewFromHash = (): View => (location.hash === '#personale' ? 'personal' : 'conversation');

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [live, setLive] = useState<LiveEvent | null>(null);
  const [online, setOnline] = useState(false);
  const [openConcept, setOpenConcept] = useState<string | null>(null);
  const closeConcept = useCallback(() => setOpenConcept(null), []);
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
    if ((e.type === 'visit.relinked' || e.type === 'visit.deleted') && e.removedConceptId === openConcept) {
      setOpenConcept(e.type === 'visit.relinked' ? e.concept.id : null);
    }
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

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
          placeholder="Cerca un concetto…"
          className="header-search"
          onPick={(c) => {
            setOpenConcept(c.id);
            setFound((prev) => ({ seq: (prev?.seq ?? 0) + 1, conceptId: c.id }));
          }}
        />
        <nav role="tablist" className="tabs">
          {tab('conversation', 'Conversazione', '#conversazione')}
          {tab('personal', 'Grafo personale', '#personale')}
        </nav>
        <DetailSetting />
        <span className={`dot ${online ? 'on' : ''}`} title={online ? 'Collegato' : 'Non collegato'} />
      </header>
      <main>
        {view === 'conversation' ? (
          <ConversationView live={live} found={found} onOpenConcept={setOpenConcept} onBackgroundClick={closeConcept} />
        ) : (
          <PersonalView live={live} found={found} onOpenConcept={setOpenConcept} onBackgroundClick={closeConcept} />
        )}
        {openConcept && (
          <DetailPanel
            conceptId={openConcept}
            version={live?.seq ?? 0}
            onClose={closeConcept}
            onOpen={setOpenConcept}
          />
        )}
      </main>
    </div>
  );
}

/** D17: opt-in "Dettaglio approfondito"; when off the server does not even expose the field to the model. */
function DetailSetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => void api.settings().then((s) => setOn(s.detail), () => setOn(null)), []);
  if (on === null) return null;
  return (
    <label
      className="setting"
      title="Quando il modello approfondisce un concetto salva anche i 5-10 punti chiave della risposta, con le sue parole. Costa qualche token in più. Vale subito, anche nelle chat già aperte."
    >
      <input type="checkbox" checked={on} onChange={(e) => void api.updateSettings({ detail: e.target.checked }).then((s) => setOn(s.detail))} />
      Dettaglio approfondito
    </label>
  );
}
