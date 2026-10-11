import { api } from './api.ts';

interface Props {
  id: string | null;
  title?: string;
  onDeleted: () => void;
}

/** Deletes the shown conversation's map after an explicit confirmation; concepts used elsewhere stay in the personal graph. */
export function DeleteConversation({ id, title, onDeleted }: Props) {
  if (!id) return null;
  const remove = () => {
    const ok = window.confirm(
      `Cancellare la mappa «${title ?? 'senza titolo'}»?\n\nI concetti usati anche in altre conversazioni restano nel grafo personale; gli altri vengono rimossi con le loro relazioni.`,
    );
    if (ok) void api.deleteConversation(id).then(onDeleted);
  };
  return (
    <button type="button" className="secondary danger" onClick={remove} title="Cancella questa mappa" aria-label="Cancella la mappa">
      Cancella mappa
    </button>
  );
}
