import { useEffect, useMemo, useRef, useState } from 'react';
import { api, READONLY, type Conversation } from './api.ts';

interface LinkProps {
  /** The graph on screen, and the selected node the reference would hang under (none = top level). */
  graph: Conversation | null;
  parentTitle?: string;
  parentId?: string | null;
  onLinked: (referenceId: string) => void;
  onError: (e: unknown) => void;
}

/** "↗" button of the graph bar: picks another graph by title and links the two with a pair of reference nodes (D25). */
export function LinkGraph({ graph, parentTitle, parentId, onLinked, onError }: LinkProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState<Conversation[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    void api.conversations().then(setAll);
    input.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => c.id !== graph?.id && words.every((w) => c.title.toLowerCase().includes(w))).slice(0, 12);
  }, [all, query, graph]);
  if (READONLY || !graph) return null;
  const pick = (target: Conversation) => {
    setOpen(false);
    api
      .createReference(graph.id, target.id, parentId ?? null)
      .then(([a]) => onLinked(a.id))
      .catch(onError);
  };
  return (
    <div className="bar-menu">
      <button
        type="button"
        className="bar-button bar-icon"
        title={parentTitle ? `Collega a un altro grafo… (sotto «${parentTitle}»)` : 'Collega a un altro grafo…'}
        aria-label="Collega a un altro grafo"
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        ↗
      </button>
      {open && (
        <div className="menu link-picker" role="dialog" aria-label="Collega a un altro grafo">
          <input
            ref={input}
            value={query}
            placeholder="Cerca un grafo per titolo…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && matches[0] && pick(matches[0])}
          />
          {matches.length === 0 ? (
            <p className="muted">Nessun altro grafo.</p>
          ) : (
            matches.map((c) => (
              <button key={c.id} type="button" role="menuitem" onClick={() => pick(c)}>
                {c.title}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** "← torna a X": back to the graph a reference was followed from. */
export function BackToGraph({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <button type="button" className="bar-button back-graph" onClick={onBack} title={`Torna al grafo «${title}»`}>
      ← torna a {title}
    </button>
  );
}
