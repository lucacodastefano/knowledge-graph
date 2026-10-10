import { useEffect, useState } from 'react';
import { api, explain, type ConceptPage, type ConceptSection } from './api.ts';
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
  const [detail, setDetail] = useState<ConceptPage | null>(null);
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
                  {v.conversationTitle}
                  {v.parentTitle && <> · sotto «{v.parentTitle}»</>} · {fmt(v.createdAt)}
                </div>
                <p>{v.summary}</p>
                {v.detail && <KeyPoints text={v.detail} />}
                {v.excerpt && <blockquote>{v.excerpt}</blockquote>}
                <Sections sections={v.sections} level={3} />
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}

/** The model's key points (D17), one per line, shown as a list. */
function KeyPoints({ text }: { text: string }) {
  const points = text.split('\n').map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter(Boolean);
  return (
    <ul className="key-points">
      {points.map((p, i) => (
        <li key={i}>{p}</li>
      ))}
    </ul>
  );
}

/** Sub-concepts as sections (D17): the real content of "Approfondisci" without extra tokens. */
function Sections({ sections, level }: { sections: ConceptSection[]; level: 3 | 4 }) {
  if (sections.length === 0) return null;
  const H = level === 3 ? 'h3' : 'h4';
  return (
    <div className="sections">
      {sections.map((s, i) => (
        <section key={i}>
          <H>{s.title}</H>
          <p>{s.summary}</p>
          {s.detail && <KeyPoints text={s.detail} />}
          {level === 3 && <Sections sections={s.children} level={4} />}
        </section>
      ))}
    </div>
  );
}
