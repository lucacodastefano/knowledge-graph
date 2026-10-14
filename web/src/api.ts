import type {
  Concept,
  ConceptOccurrence,
  ConceptPage,
  ConceptSection,
  ConceptSource,
  Conversation,
  ConversationTree,
  PersonalGraph,
  GroupSuggestion,
  TextHit,
  Visit,
} from '../../src/core/types.ts';
import type { Metrics, Period } from '../../src/core/metrics.ts';
import type { LayoutEntry } from '../../src/core/repository.ts';
import type { TrackerEvent, VisitEdit } from '../../src/core/tracker.ts';
import type { MapSnapshot } from '../../src/core/reader.ts';

export type { Metrics, Period, GroupSuggestion, Concept, ConceptOccurrence, ConceptPage, ConceptSection, ConceptSource, Conversation, ConversationTree, PersonalGraph, TextHit, TrackerEvent, Visit, VisitEdit };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Writes return the server's error message, so the canvas can show why an edit was refused. */
async function send<T>(method: 'PATCH' | 'POST' | 'DELETE', path: string, body?: object): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(err?.error ?? err?.message ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** The daemon speaks English (its messages also reach the model); the canvas speaks Italian. */
export function explain(message: string): string {
  const exists = /^"(.+)" already exists/.exec(message);
  if (exists) return `Esiste già «${exists[1]}»: usa «Unisci a…» per fondere i due concetti.`;
  if (/related to itself/.test(message)) return 'Sono lo stesso concetto: per fonderli usa «Unisci a…».';
  if (/descendants/.test(message)) return 'Un nodo non può finire sotto sé stesso o un suo discendente.';
  if (/not found|: 404$/.test(message)) return 'Non esiste più: forse è stato già modificato.';
  if (/Empty/.test(message)) return 'Il nome non può essere vuoto.';
  return `Modifica rifiutata: ${message}`;
}

const live = {
  conversations: () => get<Conversation[]>('/api/conversations'),
  deleteConversation: (id: string) => send<void>('DELETE', `/api/conversations/${id}`),
  tree: (id: string) => get<ConversationTree>(`/api/conversations/${id}/tree`),
  /** Opened from a map, the page leads with that map's occurrence (D22). */
  concept: (id: string, conversationId?: string | null) => get<ConceptPage>(`/api/concepts/${id}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ''}`),
  layout: () => get<LayoutEntry[]>('/api/layout'),
  /** An item without x / y is forgotten. */
  saveLayout: (items: Partial<LayoutEntry>[]) => send<void>('POST', '/api/layout', { items }),
  metrics: (conversation: string, period: Period) =>
    get<Metrics>(`/api/metrics?period=${period}${conversation ? `&conversation=${encodeURIComponent(conversation)}` : ''}`),
  graph: () => get<PersonalGraph>('/api/graph'),
  search: (q: string) => get<Concept[]>(`/api/search?q=${encodeURIComponent(q)}`),
  searchText: (q: string) => get<TextHit[]>(`/api/search/text?q=${encodeURIComponent(q)}`),
  renameConcept: (id: string, name: string) => send<Concept>('PATCH', `/api/concepts/${id}`, { name }),
  mergeConcept: (id: string, into: string) => send<Concept>('POST', `/api/concepts/${id}/merge`, { into }),
  deleteConcept: (id: string) => send<void>('DELETE', `/api/concepts/${id}`),
  editVisit: (id: string, edit: VisitEdit) => send<Visit>('PATCH', `/api/visits/${id}`, edit),
  /** `detach`: the children become roots instead of moving up to the parent. */
  deleteVisit: (id: string, detach = false) => send<void>('DELETE', `/api/visits/${id}${detach ? '?children=detach' : ''}`),
  restoreVisit: (input: object) => send<Visit>('POST', '/api/visits/restore', input),
  /** A relation belongs to the map it is drawn in; without one it only relabels the existing ones. */
  relate: (from: string, to: string, label?: string | null, conversationId?: string | null) =>
    send<void>('POST', '/api/relations', { from, to, label, ...(conversationId ? { conversationId } : {}) }),
  setSuperclass: (id: string, superclassId: string | null) => send<void>('PATCH', `/api/concepts/${id}/superclass`, { superclassId }),
  group: (name: string, conceptIds: string[]) => send<Concept>('POST', '/api/groups', { name, conceptIds }),
  suggestions: () => get<GroupSuggestion[]>('/api/suggestions'),
  ignoreSuggestion: (key: string) => send<void>('POST', '/api/suggestions/ignore', { key }),
  unrelate: (from: string, to: string, conversationId?: string | null) =>
    send<void>('POST', '/api/relations/remove', { from, to, ...(conversationId ? { conversationId } : {}) }),
  removeSource: (visitId: string, sourceId: string) => send<void>('DELETE', `/api/visits/${visitId}/sources/${sourceId}`),
};

/** The map embedded by "Esporta come pagina web" (D23); null when the canvas runs against the daemon. */
function readSnapshot(): MapSnapshot | null {
  try {
    const text = document.getElementById('kg-snapshot')?.textContent;
    return text ? (JSON.parse(text) as MapSnapshot) : null;
  } catch {
    return null;
  }
}
const snapshot = readSnapshot();
/** An exported page: one map, read only, no daemon. Every editing affordance checks this. */
export const READONLY = snapshot !== null;
/** The layout the exported map was viewed with. */
export const SNAPSHOT_LAYOUT = snapshot?.layoutKind;

const SEARCH_LIMIT = 20;
const SNIPPET = 60;
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The search box of an exported page: the words must all appear in the node's title, summary or detail. */
function searchSnapshot(snap: MapSnapshot, q: string): TextHit[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: TextHit[] = [];
  for (const v of snap.tree.visits) {
    const fields = { title: v.title, summary: v.summary, detail: v.detail ?? '' };
    const hay = fold(Object.values(fields).join('\n'));
    if (!words.every((w) => hay.includes(w))) continue;
    const field = (['title', 'summary', 'detail'] as const).find((f) => fold(fields[f]).includes(words[0])) ?? 'detail';
    const text = fields[field];
    const at = Math.max(0, fold(text).indexOf(words[0]));
    const snippet = field === 'title' ? '' : `${at > SNIPPET ? '…' : ''}${text.slice(Math.max(0, at - SNIPPET), at + SNIPPET).replace(/\s+/g, ' ')}`;
    hits.push({ visitId: v.id, conversationId: v.conversationId, conversationTitle: snap.tree.conversation.title, conceptId: v.conceptId, title: v.title, summary: v.summary, field, snippet });
    if (hits.length >= SEARCH_LIMIT) break;
  }
  return hits;
}

/** Same calls answered from the snapshot; anything that would write or leave the map is refused. */
function offlineApi(snap: MapSnapshot): typeof live {
  const refuse = () => Promise.reject(new Error('Pagina esportata: sola lettura'));
  const refused = Object.fromEntries(Object.keys(live).map((k) => [k, refuse])) as unknown as typeof live;
  return {
    ...refused,
    conversations: () => Promise.resolve([snap.tree.conversation]),
    tree: () => Promise.resolve(snap.tree),
    concept: (id: string) => (snap.pages[id] ? Promise.resolve(snap.pages[id]) : Promise.reject(new Error('Not found'))),
    layout: () => Promise.resolve(snap.layout),
    search: (q: string) => {
      const ids = new Set(searchSnapshot(snap, q).map((h) => h.conceptId));
      return Promise.resolve(Object.values(snap.pages).filter((p) => ids.has(p.id)).map(({ id, name, createdAt, lastSeenAt, visitCount }) => ({ id, name, createdAt, lastSeenAt, visitCount })));
    },
    searchText: (q: string) => Promise.resolve(searchSnapshot(snap, q)),
  };
}

export const api = snapshot ? offlineApi(snapshot) : live;

/** Live updates from the daemon, with automatic reconnect. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: TrackerEvent) => void, onStatus: (online: boolean) => void): () => void {
  if (READONLY) return () => undefined;
  let ws: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (m) => onEvent(JSON.parse(m.data as string) as TrackerEvent);
    ws.onclose = () => {
      onStatus(false);
      if (!stopped) retry = setTimeout(open, 1000);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    ws?.close();
  };
}
