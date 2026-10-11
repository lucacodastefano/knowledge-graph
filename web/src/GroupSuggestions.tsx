import { useEffect, useState } from 'react';
import { api, explain, type GroupSuggestion } from './api.ts';
import type { LiveEvent } from './App.tsx';

/** "Raggruppa?": probable superclasses computed by the server (no model, no tokens); accept with a name, or ignore. */
export function GroupSuggestions({ live }: { live: LiveEvent | null }) {
  const [list, setList] = useState<GroupSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.suggestions().then((s) => !cancelled && setList(s), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [live]);

  if (list.length === 0) return null;
  const done = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(explain(e.message)));
  return (
    <div className="suggestions">
      <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Raggruppa? ({list.length})
      </button>
      {open && (
        <div className="suggestions-pop" role="dialog" aria-label="Raggruppamenti suggeriti">
          {error && <p className="error small">{error}</p>}
          {list.map((s) => {
            const name = names[s.key] ?? s.name;
            return (
              <div key={s.key} className="suggestion">
                <p className="small">{s.concepts.map((c) => c.name).join(' · ')}</p>
                {s.into ? (
                  <p className="small muted">in «{s.into.name}»</p>
                ) : (
                  <input
                    className="editable"
                    aria-label="Nome della superclasse"
                    value={name}
                    onChange={(e) => setNames({ ...names, [s.key]: e.target.value })}
                  />
                )}
                <button type="button" disabled={!name.trim()} onClick={() => void done(api.group(name, s.concepts.map((c) => c.id)))}>
                  Raggruppa
                </button>{' '}
                <button type="button" className="ghost" onClick={() => void done(api.ignoreSuggestion(s.key))}>
                  Ignora
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
