import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

interface Props {
  id: string | null;
  title?: string;
  onDeleted: () => void;
}

/** Overflow "⋯" menu of the conversation bar; "Cancella mappa" asks for confirmation, concepts used elsewhere stay in the personal graph. */
export function DeleteConversation({ id, title, onDeleted }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!id) return null;
  const remove = () => {
    setOpen(false);
    const ok = window.confirm(
      `Cancellare il grafo «${title ?? 'senza titolo'}»?\n\nI concetti usati anche in altri grafi restano nel grafo globale; gli altri vengono rimossi con le loro relazioni.`,
    );
    if (ok) void api.deleteConversation(id).then(onDeleted);
  };
  return (
    <div className="bar-menu" ref={box}>
      <button type="button" className="bar-button bar-icon" aria-haspopup="menu" aria-expanded={open} title="Altre azioni" aria-label="Altre azioni" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" className="danger-text" onClick={remove}>
            Cancella grafo…
          </button>
        </div>
      )}
    </div>
  );
}
