import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, READONLY } from './api.ts';

interface Props {
  id: string | null;
  title?: string;
  /** The layout on screen: the exported page opens with the same one. */
  layout?: string;
  onDeleted: () => void;
  /** Extra entries at the top of the menu (phone: the view controls that no longer fit in the bar). */
  extra?: (close: () => void) => ReactNode;
}

/** Overflow "⋯" menu of the conversation bar: export the map as a web page (D23), or delete it (asks for confirmation; concepts used elsewhere stay in the personal graph). */
export function DeleteConversation({ id, title, layout, onDeleted, extra }: Props) {
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
  if (!id || READONLY) return null;
  const remove = () => {
    setOpen(false);
    const ok = window.confirm(
      `Cancellare il grafo «${title ?? 'senza titolo'}»?\n\nI concetti usati anche in altri grafi restano nel grafo globale; gli altri vengono rimossi con le loro relazioni.`,
    );
    if (ok) void api.deleteConversation(id).then(onDeleted);
  };
  /** The daemon answers with the whole map as one .html file; the browser saves it (the session cookie covers hosted mode). */
  const exportPage = () => {
    setOpen(false);
    const a = document.createElement('a');
    a.href = `/api/conversations/${encodeURIComponent(id)}/export.html${layout ? `?layout=${layout}` : ''}`;
    a.download = '';
    a.click();
  };
  return (
    <div className="bar-menu" ref={box}>
      <button type="button" className="bar-button bar-icon" aria-haspopup="menu" aria-expanded={open} title="Altre azioni" aria-label="Altre azioni" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu">
          {extra?.(() => setOpen(false))}
          <button type="button" role="menuitem" onClick={exportPage}>
            Esporta come pagina web
          </button>
          <button type="button" role="menuitem" className="danger-text" onClick={remove}>
            Cancella grafo…
          </button>
        </div>
      )}
    </div>
  );
}
