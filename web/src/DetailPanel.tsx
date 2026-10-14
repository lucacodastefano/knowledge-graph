import { useEffect, useMemo, useState } from 'react';
import { Markdown } from './Markdown.tsx';
import { api, explain, READONLY, type ConceptOccurrence, type ConceptPage, type ConceptSection, type ConceptSource, type Visit } from './api.ts';
import { ConceptSearch } from './ConceptSearch.tsx';

const fmt = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });

type Menu = 'closed' | 'open' | 'group' | 'merge' | 'delete';

/** Editable texts of one node: an occurrence of the concept or one of its sections. */
interface NodeDraft {
  title: string;
  summary: string;
  detail: string;
  parentVisitId: string | null;
}

interface Draft {
  name: string;
  nodes: Record<string, NodeDraft>;
}

interface Props {
  conceptId: string;
  /** The map the panel was opened from: its occurrence leads, the others are collapsed (D22). Null = global graph. */
  conversationId?: string | null;
  version: number;
  onClose: () => void;
  /** Panel opened by hovering (not locked): editing or the menu lock it on this concept. */
  pinned?: boolean;
  onPin?: () => void;
  /** The pointer entered or left the panel, so the hover panel does not vanish under it. */
  onPointer?: (inside: boolean) => void;
  /** Called after a merge, to show the concept that absorbed this one. */
  onOpen: (conceptId: string) => void;
}

const draftOf = (n: { title: string; summary: string; detail: string | null; parentVisitId?: string | null }): NodeDraft => ({
  title: n.title,
  summary: n.summary,
  detail: n.detail ?? '',
  parentVisitId: n.parentVisitId ?? null,
});

function collect(sections: ConceptSection[], into: Record<string, NodeDraft>) {
  for (const s of sections) {
    into[s.id] = draftOf(s);
    collect(s.children, into);
  }
}

/**
 * "Approfondisci" (D16, D17): every occurrence of a concept with its sub-concepts as sections.
 * The pencil makes the same texts editable in place; merge and delete live in the menu.
 */
type Width = 'third' | 'half' | 'full';
const WIDTHS: { id: Width; label: string; title: string }[] = [
  { id: 'third', label: '⅓', title: 'Un terzo della larghezza' },
  { id: 'half', label: '½', title: 'Metà della larghezza' },
  { id: 'full', label: '▣', title: 'Tutto lo spazio' },
];
const WIDTH_KEY = 'kg.panelWidth';
const readWidth = (): Width => {
  try {
    const w = localStorage.getItem(WIDTH_KEY);
    if (w === 'third' || w === 'half' || w === 'full') return w;
    // Before the three widths there was one expand toggle.
    if (localStorage.getItem('kg.panelExpanded') === '1') return 'full';
  } catch {
    /* storage unavailable */
  }
  return 'third';
};

export function DetailPanel({ conceptId, conversationId = null, version, onClose, pinned = true, onPin, onPointer, onOpen }: Props) {
  const [page, setPage] = useState<ConceptPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>('closed');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [trees, setTrees] = useState<Record<string, Visit[]>>({});
  const [saving, setSaving] = useState(false);
  const [width, setWidthState] = useState<Width>(readWidth);
  const setWidth = (w: Width) => {
    setWidthState(w);
    try {
      localStorage.setItem(WIDTH_KEY, w);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  };

  useEffect(() => {
    // A reply for a concept that is no longer open (merged, deleted, another one picked) is ignored.
    let open = true;
    api.concept(conceptId, conversationId).then(
      (p) => open && setPage(p),
      (e: Error) => open && setError(explain(e.message)),
    );
    return () => {
      open = false;
    };
  }, [conceptId, conversationId, version]);
  // Esc cancels an edit first; only then does it reach the app, which leaves focus mode.
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setDraft(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setMenu('closed');
    setDraft(null);
    setError(null);
  }, [conceptId]);

  const startEditing = () => {
    if (!page) return;
    onPin?.();
    const nodes: Record<string, NodeDraft> = {};
    for (const v of page.visits) {
      nodes[v.id] = draftOf(v);
      collect(v.sections, nodes);
    }
    setDraft({ name: page.name, nodes });
    setMenu('closed');
    // The conversations' trees list where each occurrence can move.
    const ids = [...new Set(page.visits.map((v) => v.conversationId))];
    void Promise.all(ids.map((id) => api.tree(id))).then((ts) =>
      setTrees(Object.fromEntries(ts.map((t) => [t.conversation.id, t.visits]))),
    );
  };

  const save = async () => {
    if (!page || !draft) return;
    setSaving(true);
    try {
      if (draft.name.trim() !== page.name) await api.renameConcept(conceptId, draft.name);
      const original: Record<string, NodeDraft> = {};
      for (const v of page.visits) {
        original[v.id] = draftOf(v);
        collect(v.sections, original);
      }
      for (const [id, d] of Object.entries(draft.nodes)) {
        const o = original[id];
        if (!o) continue;
        const isOccurrence = page.visits.some((v) => v.id === id);
        await api.editVisit(id, {
          ...(!isOccurrence && d.title.trim() !== o.title ? { title: d.title } : {}),
          ...(d.summary.trim() !== o.summary ? { summary: d.summary } : {}),
          ...(d.detail.trim() !== o.detail ? { detail: d.detail.trim() || null } : {}),
          ...(isOccurrence && d.parentVisitId !== o.parentVisitId ? { parentVisitId: d.parentVisitId } : {}),
        });
      }
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(explain((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  const run = (action: Promise<unknown>, after?: () => void) =>
    action.then(
      () => {
        setError(null);
        setMenu('closed');
        after?.();
      },
      (e: Error) => setError(explain(e.message)),
    );

  const setNode = (id: string, patch: Partial<NodeDraft>) =>
    setDraft((d) => (d ? { ...d, nodes: { ...d.nodes, [id]: { ...d.nodes[id], ...patch } } } : d));

  // Opened from a map: that map's occurrences first, the rest in a collapsed section.
  const mine = page ? page.visits.filter((v) => !page.conversationId || v.conversationId === page.conversationId) : [];
  const others = page && page.conversationId ? page.visits.filter((v) => v.conversationId !== page.conversationId) : [];
  const occurrence = (v: ConceptOccurrence) => (
    <Occurrence
      key={v.id}
      visit={v}
      draft={draft?.nodes}
      tree={trees[v.conversationId]}
      onChange={setNode}
      onDelete={() => api.deleteVisit(v.id).then(() => setDraft(null), (e: Error) => setError(explain(e.message)))}
    />
  );

  return (
    <aside
      className={`panel${draft ? ' editing' : ''} width-${width}`}
      aria-label="Dettaglio concetto"
      onMouseEnter={() => onPointer?.(true)}
      onMouseLeave={() => onPointer?.(false)}
    >
      <header>
        {draft ? (
          <input
            className="editable title"
            aria-label="Nome del concetto"
            value={draft.name}
            autoFocus
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        ) : (
          <h2>{page?.name ?? '…'}</h2>
        )}
        <div className="panel-tools">
          {pinned && (
            <span className="pin" title="Fissato su questo concetto: clic nel vuoto, Esc o ✕ per sbloccare">
              📌 fissato
            </span>
          )}
          {page && !draft && !READONLY && (
            <>
              <button type="button" className="ghost icon" onClick={startEditing} aria-label="Modifica" title="Modifica">
                ✎
              </button>
              <button
                type="button"
                className="ghost icon"
                aria-label="Altre azioni"
                aria-expanded={menu === 'open'}
                onClick={() => {
                  onPin?.();
                  setMenu(menu === 'open' ? 'closed' : 'open');
                }}
              >
                ⋯
              </button>
            </>
          )}
          <div className="width-switch" role="group" aria-label="Larghezza del pannello">
            {WIDTHS.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`ghost icon${width === w.id ? ' active' : ''}`}
                onClick={() => setWidth(w.id)}
                aria-label={w.title}
                title={w.title}
                aria-pressed={width === w.id}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Chiudi">
            ✕
          </button>
          {menu === 'open' && (
            <div className="menu" role="menu">
              {!page?.conversationId && (
                <button type="button" role="menuitem" onClick={() => setMenu('group')}>
                  Raggruppa in…
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => setMenu('merge')}>
                Unisci a…
              </button>
              <button type="button" role="menuitem" className="danger-text" onClick={() => setMenu('delete')}>
                Elimina concetto
              </button>
            </div>
          )}
        </div>
      </header>
      {menu === 'group' && (
        <div className="edit-box">
          <p className="small">«{page?.name}» starà sotto una superclasse (una sola): scegline una esistente o creane una nuova.</p>
          <ConceptSearch
            label="Raggruppa in"
            placeholder="Cerca la superclasse…"
            exclude={conceptId}
            autoFocus
            onPick={(c) => void run(api.setSuperclass(conceptId, c.id))}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get('name') as string;
              if (name.trim()) void run(api.group(name, [conceptId]));
            }}
          >
            <input name="name" className="editable" aria-label="Nuova superclasse" placeholder="…oppure il nome di una nuova" />
            <button type="submit">Crea e raggruppa</button>
          </form>
          <button type="button" className="ghost" onClick={() => setMenu('closed')}>
            Annulla
          </button>
        </div>
      )}
      {menu === 'merge' && (
        <div className="edit-box">
          <p className="small">Le visite di «{page?.name}» passeranno al concetto scelto, poi questo sparirà.</p>
          <ConceptSearch
            label="Unisci a"
            placeholder="Cerca il concetto giusto…"
            exclude={conceptId}
            autoFocus
            onPick={(c) => void run(api.mergeConcept(conceptId, c.id), () => onOpen(c.id))}
          />
          <button type="button" className="ghost" onClick={() => setMenu('closed')}>
            Annulla
          </button>
        </div>
      )}
      {menu === 'delete' && page && (
        <div className="edit-box">
          <p className="small">
            Elimina «{page.name}» e i suoi {page.visits.length} nodi da tutti i grafi. I nodi figli salgono di un
            livello.
          </p>
          <button type="button" className="danger" onClick={() => void run(api.deleteConcept(conceptId), onClose)}>
            Conferma eliminazione
          </button>
          <button type="button" className="ghost" onClick={() => setMenu('closed')}>
            Annulla
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && (
        <>
          <p className="muted">
            Visto {mine.length} {mine.length === 1 ? 'volta' : 'volte'}
            {page.conversationId ? ' in questo grafo' : ''}, l'ultima {fmt(page.lastSeenAt)}
          </p>
          {(page.superclass || page.members.length > 0) && (
            <section className="groups" aria-label="Gruppi">
              {page.superclass && (
                <p className="small">
                  In:{' '}
                  <button type="button" className="link" onClick={() => onOpen(page.superclass!.id)}>
                    {page.superclass.name}
                  </button>{' '}
                  <button
                    type="button"
                    className="ghost icon"
                    aria-label="Togli dal gruppo"
                    title="Togli dal gruppo"
                    onClick={() => void run(api.setSuperclass(conceptId, null))}
                  >
                    ✕
                  </button>
                </p>
              )}
              {page.members.length > 0 && (
                <>
                  <h3>Contiene</h3>
                  <ul>
                    {page.members.map((m) => (
                      <li key={m.id}>
                        <button type="button" className="link" onClick={() => onOpen(m.id)}>
                          {m.name}
                        </button>{' '}
                        <button
                          type="button"
                          className="ghost icon"
                          aria-label={`Togli ${m.name} dal gruppo`}
                          title="Togli dal gruppo"
                          onClick={() => void run(api.setSuperclass(m.id, null))}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          <ol className="visits">{mine.map(occurrence)}</ol>
          {others.length > 0 && (
            <details className="other-maps">
              <summary>Anche in altri grafi ({others.length})</summary>
              <ol className="visits">{others.map(occurrence)}</ol>
            </details>
          )}
          {page.related.length > 0 && (
            <section className="related" aria-label="Relazioni">
              <h3>Relazioni</h3>
              <ul className="relations">
                {page.related.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="rel-name" onClick={() => onOpen(r.id)}>
                      {r.name}
                    </button>
                    {r.label && <em className="rel-label">{r.label}</em>}
                    {!READONLY && <span className="rel-actions">
                      <button
                        type="button"
                        className="rel-icon"
                        aria-label={`Etichetta della relazione con ${r.name}`}
                        title="Etichetta"
                        onClick={() => {
                          const label = window.prompt('Etichetta della relazione (vuota per toglierla)', r.label ?? '');
                          if (label !== null) void run(api.relate(conceptId, r.id, label.trim() || null, page.conversationId));
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="rel-icon danger"
                        aria-label={`Rimuovi la relazione con ${r.name}`}
                        title="Rimuovi la relazione"
                        onClick={() => void run(api.unrelate(conceptId, r.id, page.conversationId))}
                      >
                        ✕
                      </button>
                    </span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Sources
            sources={page.sources}
            editing={draft !== null}
            onRemove={(s) =>
              // The concept page lists a source once: remove it from every node of this concept that cites it.
              Promise.all(s.visitIds.map((id) => api.removeSource(id, s.id))).then(
                () => setError(null),
                (e: Error) => setError(explain(e.message)),
              )
            }
          />
          {draft && (
            <div className="save-bar">
              <button type="button" disabled={saving} onClick={() => void save()}>
                Salva
              </button>
              <button type="button" className="ghost" onClick={() => setDraft(null)}>
                Annulla
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

interface OccurrenceProps {
  visit: ConceptOccurrence;
  draft: Record<string, NodeDraft> | undefined;
  tree: Visit[] | undefined;
  onChange: (id: string, patch: Partial<NodeDraft>) => void;
  onDelete: () => void;
}

function Occurrence({ visit: v, draft, tree, onChange, onDelete }: OccurrenceProps) {
  const [confirm, setConfirm] = useState(false);
  const d = draft?.[v.id];
  // A node can move anywhere in its conversation except under itself or its own subtree.
  const parents = useMemo(() => {
    if (!tree) return [];
    const children = new Map<string | null, Visit[]>();
    for (const n of tree) children.set(n.parentVisitId, [...(children.get(n.parentVisitId) ?? []), n]);
    const out: { visit: Visit; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const n of children.get(parent) ?? []) {
        if (n.id === v.id) continue;
        out.push({ visit: n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [tree, v.id]);

  return (
    <li>
      <div className="muted small">
        {v.conversationTitle}
        {d ? (
          <>
            {' · sotto '}
            <select
              className="editable inline"
              aria-label="Sotto"
              value={d.parentVisitId ?? ''}
              onChange={(e) => onChange(v.id, { parentVisitId: e.target.value || null })}
            >
              <option value="">radice del grafo</option>
              {parents.map(({ visit: p, depth }) => (
                <option key={p.id} value={p.id}>
                  {'  '.repeat(depth)}
                  {p.title}
                </option>
              ))}
            </select>
          </>
        ) : (
          v.parentTitle && <> · sotto «{v.parentTitle}»</>
        )}{' '}
        · {fmt(v.createdAt)}
      </div>
      <Texts id={v.id} summary={v.summary} detail={v.detail} draft={d} onChange={onChange} />
      {v.excerpt && <blockquote>{v.excerpt}</blockquote>}
      <Sections sections={v.sections} level={3} draft={draft} onChange={onChange} />
      {d &&
        (confirm ? (
          <div className="actions">
            <button type="button" className="danger" onClick={onDelete}>
              Conferma eliminazione
            </button>
            <button type="button" className="ghost" onClick={() => setConfirm(false)}>
              Annulla
            </button>
          </div>
        ) : (
          <button type="button" className="ghost danger-text small" onClick={() => setConfirm(true)}>
            Elimina questo nodo (i figli salgono)
          </button>
        ))}
    </li>
  );
}

interface TextsProps {
  id: string;
  summary: string;
  detail: string | null;
  draft: NodeDraft | undefined;
  onChange: (id: string, patch: Partial<NodeDraft>) => void;
}

/** Node label text and the full detail of the answer (markdown), read-only or edited in place. */
function Texts({ id, summary, detail, draft, onChange }: TextsProps) {
  if (!draft) {
    return (
      <>
        <p>{summary}</p>
        {detail && <Markdown text={detail} />}
      </>
    );
  }
  return (
    <>
      <textarea
        className="editable"
        aria-label="Testo dalla risposta"
        value={draft.summary}
        onChange={(e) => onChange(id, { summary: e.target.value })}
      />
      {(detail || draft.detail) && (
        <textarea
          className="editable"
          aria-label="Dettaglio della risposta"
          value={draft.detail}
          onChange={(e) => onChange(id, { detail: e.target.value })}
        />
      )}
    </>
  );
}

interface SectionsProps {
  sections: ConceptSection[];
  /** Heading level: 3 for the children of the concept, one deeper per generation (capped at h6). */
  level: number;
  draft: Record<string, NodeDraft> | undefined;
  onChange: (id: string, patch: Partial<NodeDraft>) => void;
}

/** Sub-concepts as sections (D17): the real content of "Approfondisci" without extra tokens. */
function Sections({ sections, level, draft, onChange }: SectionsProps) {
  if (sections.length === 0) return null;
  const H = `h${Math.min(level, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
  return (
    <div className="sections">
      {sections.map((s) => {
        const d = draft?.[s.id];
        return (
          <section key={s.id}>
            {d ? (
              <input
                className={`editable ${H}`}
                aria-label="Titolo sezione"
                value={d.title}
                onChange={(e) => onChange(s.id, { title: e.target.value })}
              />
            ) : (
              <H>{s.title}</H>
            )}
            <Texts id={s.id} summary={s.summary} detail={s.detail} draft={d} onChange={onChange} />
            <Sections sections={s.children} level={level + 1} draft={draft} onChange={onChange} />
          </section>
        );
      })}
    </div>
  );
}

/** "host/path" of a source, as shown in the panel: no scheme, no query (the full URL is in the tooltip). */
function sourceLabel(s: ConceptSource): string {
  try {
    const { pathname } = new URL(s.url);
    return pathname === '/' ? s.domain : `${s.domain}${pathname}`;
  } catch {
    return s.url;
  }
}

interface SourcesProps {
  sources: ConceptSource[];
  editing: boolean;
  onRemove: (source: ConceptSource) => void;
}

/** "Fonti": the pages the model cited for this concept, in every conversation; removable while editing. */
function Sources({ sources, editing, onRemove }: SourcesProps) {
  if (sources.length === 0) return null;
  return (
    <section className="sources" aria-label="Fonti">
      <h3>Fonti</h3>
      <ul>
        {sources.map((s) => (
          <li key={s.id}>
            <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
              {sourceLabel(s)}
            </a>
            {editing && (
              <button
                type="button"
                className="ghost icon small"
                aria-label={`Rimuovi fonte ${s.domain}`}
                title="Rimuovi fonte"
                onClick={() => onRemove(s)}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
