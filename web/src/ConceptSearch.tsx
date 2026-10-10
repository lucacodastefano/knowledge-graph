import { useEffect, useState } from 'react';
import { api, type Concept } from './api.ts';

interface Props {
  label: string;
  placeholder: string;
  onPick: (concept: Concept) => void;
  /** Concept left out of the results (e.g. the one being merged). */
  exclude?: string;
  autoFocus?: boolean;
  className?: string;
}

const DEBOUNCE_MS = 150;

/** Search box over every concept (RF17): used for the canvas search and to pick a target concept. */
export function ConceptSearch({ label, placeholder, onPick, exclude, autoFocus, className }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Concept[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setResults([]);
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(q).then((r) => {
        if (!cancelled) setResults(r.filter((c) => c.id !== exclude));
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, exclude]);

  const pick = (c: Concept) => {
    setQuery('');
    setResults([]);
    onPick(c);
  };

  return (
    <div className={`search ${className ?? ''}`}>
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) pick(results[0]);
          if (e.key === 'Escape') setQuery('');
        }}
      />
      {query.trim() && (
        <ul className="results" role="listbox" aria-label={`Risultati: ${label}`}>
          {results.length === 0 && <li className="muted small">Nessun concetto trovato</li>}
          {results.map((c) => (
            <li key={c.id} role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
              <span>{c.name}</span>
              <span className="muted small">×{c.visitCount}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
