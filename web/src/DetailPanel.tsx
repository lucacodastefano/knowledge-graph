import { useEffect, useState } from 'react';
import { api, type ConceptDetail } from './api.ts';

const fmt = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });

/** Full view of a concept: every visit, across all conversations. */
export function DetailPanel({ conceptId, version, onClose }: { conceptId: string; version: number; onClose: () => void }) {
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.concept(conceptId).then(setDetail, (e: Error) => setError(e.message));
  }, [conceptId, version]);

  return (
    <aside className="panel" aria-label="Dettaglio concetto">
      <header>
        <h2>{detail?.name ?? '…'}</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Chiudi">
          ✕
        </button>
      </header>
      {error && <p className="muted">Impossibile caricare: {error}</p>}
      {detail && (
        <>
          <p className="muted">
            Visto {detail.visits.length} {detail.visits.length === 1 ? 'volta' : 'volte'}, l'ultima {fmt(detail.lastSeenAt)}
          </p>
          <ol className="visits">
            {detail.visits.map((v) => (
              <li key={v.id}>
                <div className="muted small">
                  {v.conversationTitle} · {fmt(v.createdAt)}
                </div>
                <p>{v.summary}</p>
                {v.excerpt && <blockquote>{v.excerpt}</blockquote>}
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
