import { useEffect, useState } from 'react';
import { api, type Concept, type TextHit } from './api.ts';

interface Props {
  label: string;
  placeholder: string;
  onPick: (concept: Concept) => void;
  /** Also search inside the text of every map; a hit opens the node in its own map. */
  onPickHit?: (hit: TextHit) => void;
  /** Concept left out of the results (e.g. the one being merged). */
  exclude?: string;
  autoFocus?: boolean;
  className?: string;
}

const DEBOUNCE_MS = 150;

/** Search box over every concept (RF17): used for the canvas search and to pick a target concept. */
export function ConceptSearch({ label, placeholder, onPick, onPickHit, exclude, autoFocus, className }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Concept[]>([]);
  const [hits, setHits] = useState<TextHit[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setResults([]), setHits([]);
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(q).then((r) => {
        if (!cancelled) setResults(r.filter((c) => c.id !== exclude));
      });
      if (onPickHit) {
        api.searchText(q).then((r) => {
          if (!cancelled) setHits(r);
        });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, exclude, onPickHit]);

  const pick = (c: Concept) => {
    setQuery('');
    setResults([]);
    setHits([]);
    onPick(c);
  };
  const pickHit = (h: TextHit) => {
    setQuery('');
    setResults([]);
    setHits([]);
    onPickHit?.(h);
  };
  // Concepts the text hits already show as a name match are not listed twice.
  const textHits = hits.filter((h) => !results.some((c) => c.id === h.conceptId && c.name === h.title && h.field === 'title'));
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const marked = (text: string) => {
    if (!words.length) return text;
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
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
          if (e.key === 'Enter') {
            if (results[0]) pick(results[0]);
            else if (textHits[0]) pickHit(textHits[0]);
          }
          if (e.key === 'Escape') setQuery('');
        }}
      />
      {query.trim() && (
        <ul className="results" role="listbox" aria-label={`Risultati: ${label}`}>
          {results.length === 0 && textHits.length === 0 && <li className="muted small">Nessun risultato</li>}
          {results.map((c) => (
            <li key={c.id} role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
              <span>{c.name}</span>
              <span className="muted small">×{c.visitCount}</span>
            </li>
          ))}
          {textHits.length > 0 && <li className="muted small results-head">Nel testo dei grafi</li>}
          {textHits.map((h) => (
            <li key={h.visitId} className="hit" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pickHit(h)}>
              <span className="hit-title">
                {h.title}
                <span className="muted small"> · {h.conversationTitle}</span>
              </span>
              {h.snippet && <span className="muted small hit-snippet">{marked(h.snippet)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
