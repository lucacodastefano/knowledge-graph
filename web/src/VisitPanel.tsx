import { useEffect, useMemo, useState } from 'react';
import { api, explain, type VisitEdit, type Visit } from './api.ts';
import { ConceptSearch } from './ConceptSearch.tsx';

interface Props {
  visit: Visit;
  /** Every node of the conversation, to choose a new parent. */
  visits: Visit[];
  onClose: () => void;
}

const ROOT = '';

/** Corrections on a single node of the tree (D8): rename, move, link to another concept, delete. */
export function VisitPanel({ visit, visits, onClose }: Props) {
  const [title, setTitle] = useState(visit.title);
  const [conceptName, setConceptName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(visit.title);
    setConfirmDelete(false);
    setError(null);
  }, [visit.id, visit.title]);
  useEffect(() => {
    api.concept(visit.conceptId).then((c) => setConceptName(c.name), () => setConceptName(null));
  }, [visit.conceptId]);

  // A node can move anywhere except under itself or its own subtree.
  const parents = useMemo(() => {
    const children = new Map<string | null, Visit[]>();
    for (const v of visits) children.set(v.parentVisitId, [...(children.get(v.parentVisitId) ?? []), v]);
    const out: { visit: Visit; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const v of children.get(parent) ?? []) {
        if (v.id === visit.id) continue;
        out.push({ visit: v, depth });
        walk(v.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [visits, visit.id]);

  const edit = (change: VisitEdit) => api.editVisit(visit.id, change).then(() => setError(null), (e: Error) => setError(explain(e.message)));

  return (
    <aside className="panel left" aria-label="Modifica nodo">
      <header>
        <h2>Modifica nodo</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Chiudi modifica">
          ✕
        </button>
      </header>

      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void edit({ title });
        }}
      >
        <label htmlFor="visit-title">Titolo</label>
        <div className="inline-form">
          <input id="visit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" disabled={title.trim() === visit.title}>
            Salva
          </button>
        </div>
      </form>

      <div className="field">
        <label htmlFor="visit-parent">Sotto</label>
        <select
          id="visit-parent"
          value={visit.parentVisitId ?? ROOT}
          onChange={(e) => void edit({ parentVisitId: e.target.value || null })}
        >
          <option value={ROOT}>— radice della conversazione —</option>
          {parents.map(({ visit: p, depth }) => (
            <option key={p.id} value={p.id}>
              {'  '.repeat(depth)}
              {p.title}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Concetto</label>
        <p className="small">
          Collegato a <strong>{conceptName ?? '…'}</strong>. Se è lo stesso di un altro concetto, collegalo lì.
        </p>
        <ConceptSearch
          label="Collega a concetto"
          placeholder="Cerca un concetto…"
          exclude={visit.conceptId}
          onPick={(c) => void edit({ conceptId: c.id })}
        />
      </div>

      <div className="field">
        {confirmDelete ? (
          <>
            <p className="small">I nodi figli saliranno sotto il genitore di questo nodo.</p>
            <button
              type="button"
              className="danger"
              onClick={() => api.deleteVisit(visit.id).then(onClose, (e: Error) => setError(explain(e.message)))}
            >
              Conferma eliminazione
            </button>
            <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>
              Annulla
            </button>
          </>
        ) : (
          <button type="button" className="secondary danger" onClick={() => setConfirmDelete(true)}>
            Elimina nodo
          </button>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
