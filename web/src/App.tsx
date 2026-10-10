import { useEffect, useState } from 'react';
import { subscribe, type TrackerEvent } from './api.ts';
import { ConversationView } from './ConversationView.tsx';
import { PersonalView } from './PersonalView.tsx';
import { DetailPanel } from './DetailPanel.tsx';

/** A tracker event with a sequence number, so views can react to every change. */
export interface LiveEvent {
  seq: number;
  event: TrackerEvent;
}

type View = 'conversation' | 'personal';
const viewFromHash = (): View => (location.hash === '#personale' ? 'personal' : 'conversation');

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [live, setLive] = useState<LiveEvent | null>(null);
  const [online, setOnline] = useState(false);
  const [openConcept, setOpenConcept] = useState<string | null>(null);

  useEffect(() => subscribe((event) => setLive((prev) => ({ seq: (prev?.seq ?? 0) + 1, event })), setOnline), []);
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
        <nav role="tablist" className="tabs">
          {tab('conversation', 'Conversazione', '#conversazione')}
          {tab('personal', 'Grafo personale', '#personale')}
        </nav>
        <span className={`dot ${online ? 'on' : ''}`} title={online ? 'Collegato' : 'Non collegato'} />
      </header>
      <main>
        {view === 'conversation' ? (
          <ConversationView live={live} onOpenConcept={setOpenConcept} />
        ) : (
          <PersonalView live={live} onOpenConcept={setOpenConcept} />
        )}
        {openConcept && <DetailPanel conceptId={openConcept} version={live?.seq ?? 0} onClose={() => setOpenConcept(null)} />}
      </main>
    </div>
  );
}
