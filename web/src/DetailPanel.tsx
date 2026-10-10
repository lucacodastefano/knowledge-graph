import { useEffect, useState } from 'react';
import { api, explain, type ConceptDetail } from './api.ts';
import { ConceptSearch } from './ConceptSearch.tsx';

const fmt = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });

type Mode = 'view' | 'rename' | 'merge' | 'delete';

interface Props {
  conceptId: string;
  version: number;
  onClose: () => void;
  /** Called after a merge, to show the concept that absorbed this one. */
  onOpen: (conceptId: string) => void;
}

/** Full view of a concept: every visit, across all conversations, plus the manual corrections (D8). */
export function DetailPanel({ conceptId, version, onClose, onOpen }: Props) {
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [name, setName] = useState('');

  useEffect(() => {
    api.concept(conceptId).then(setDetail, (e: Error) => setError(e.message));
  }, [conceptId, version]);
  useEffect(() => {
    setMode('view');
    setError(null);
  }, [conceptId]);

  const run = (action: Promise<unknown>, after?: () => void) =>
    action.then(
      () => {
        setError(null);
        setMode('view');
        after?.();
      },
      (e: Error) => setError(explain(e.message)),
    );

  return (
    <aside className="panel" aria-label="Dettaglio concetto">
      <header>
        {mode === 'rename' ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(api.renameConcept(conceptId, name));
            }}
          >
            <input aria-label="Nuovo nome" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <button type="submit">Salva</button>
            <button type="button" className="ghost" onClick={() => setMode('view')}>
              Annulla
            </button>
          </form>
        ) : (
          <h2>{detail?.name ?? '…'}</h2>
        )}
        <button type="button" className="ghost" onClick={onClose} aria-label="Chiudi">
          ✕
        </button>
      </header>
      {detail && mode === 'view' && (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setName(detail.name);
              setMode('rename');
            }}
          >
            Rinomina
          </button>
          <button type="button" className="secondary" onClick={() => setMode('merge')}>
            Unisci a…
          </button>
          <button type="button" className="secondary danger" onClick={() => setMode('delete')}>
            Elimina
          </button>
        </div>
      )}
      {mode === 'merge' && (
        <div className="edit-box">
          <p className="small">Le visite di «{detail?.name}» passeranno al concetto scelto, poi questo sparirà.</p>
          <ConceptSearch
            label="Unisci a"
            placeholder="Cerca il concetto giusto…"
            exclude={conceptId}
            autoFocus
            onPick={(c) => void run(api.mergeConcept(conceptId, c.id), () => onOpen(c.id))}
          />
          <button type="button" className="ghost" onClick={() => setMode('view')}>
            Annulla
          </button>
        </div>
      )}
      {mode === 'delete' && detail && (
        <div className="edit-box">
          <p className="small">
            Elimina «{detail.name}» e i suoi {detail.visits.length} nodi da tutte le conversazioni. I nodi figli salgono di
            un livello.
          </p>
          <button type="button" className="danger" onClick={() => void run(api.deleteConcept(conceptId), onClose)}>
            Conferma eliminazione
          </button>
          <button type="button" className="ghost" onClick={() => setMode('view')}>
            Annulla
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
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
