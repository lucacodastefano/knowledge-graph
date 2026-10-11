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
  Settings,
  TextHit,
  Visit,
} from '../../src/core/types.ts';
import type { LayoutEntry } from '../../src/core/repository.ts';
import type { TrackerEvent, VisitEdit } from '../../src/core/tracker.ts';

export type { GroupSuggestion, Concept, ConceptOccurrence, ConceptPage, ConceptSection, ConceptSource, Conversation, ConversationTree, PersonalGraph, Settings, TextHit, TrackerEvent, Visit, VisitEdit };

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
  if (/not found/.test(message)) return 'Non esiste più: forse è stato già modificato.';
  if (/Empty/.test(message)) return 'Il nome non può essere vuoto.';
  return `Modifica rifiutata: ${message}`;
}

export const api = {
  conversations: () => get<Conversation[]>('/api/conversations'),
  deleteConversation: (id: string) => send<void>('DELETE', `/api/conversations/${id}`),
  tree: (id: string) => get<ConversationTree>(`/api/conversations/${id}/tree`),
  concept: (id: string) => get<ConceptPage>(`/api/concepts/${id}`),
  layout: () => get<LayoutEntry[]>('/api/layout'),
  /** An item without x / y is forgotten. */
  saveLayout: (items: Partial<LayoutEntry>[]) => send<void>('POST', '/api/layout', { items }),
  settings: () => get<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) => send<Settings>('PATCH', '/api/settings', patch),
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
  relate: (from: string, to: string, label?: string | null) => send<void>('POST', '/api/relations', { from, to, label }),
  setSuperclass: (id: string, superclassId: string | null) => send<void>('PATCH', `/api/concepts/${id}/superclass`, { superclassId }),
  group: (name: string, conceptIds: string[]) => send<Concept>('POST', '/api/groups', { name, conceptIds }),
  suggestions: () => get<GroupSuggestion[]>('/api/suggestions'),
  ignoreSuggestion: (key: string) => send<void>('POST', '/api/suggestions/ignore', { key }),
  unrelate: (from: string, to: string) => send<void>('POST', '/api/relations/remove', { from, to }),
  removeSource: (visitId: string, sourceId: string) => send<void>('DELETE', `/api/visits/${visitId}/sources/${sourceId}`),
};

/** Live updates from the daemon, with automatic reconnect. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: TrackerEvent) => void, onStatus: (online: boolean) => void): () => void {
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
