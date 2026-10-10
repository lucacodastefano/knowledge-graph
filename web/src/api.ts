import type { Concept, ConceptDetail, Conversation, ConversationTree, PersonalGraph, Visit } from '../../src/core/types.ts';
import type { TrackerEvent, VisitEdit } from '../../src/core/tracker.ts';

export type { Concept, ConceptDetail, Conversation, ConversationTree, PersonalGraph, TrackerEvent, Visit, VisitEdit };

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
  if (/descendants/.test(message)) return 'Un nodo non può finire sotto sé stesso o un suo discendente.';
  if (/not found/.test(message)) return 'Non esiste più: forse è stato già modificato.';
  if (/Empty/.test(message)) return 'Il nome non può essere vuoto.';
  return `Modifica rifiutata: ${message}`;
}

export const api = {
  conversations: () => get<Conversation[]>('/api/conversations'),
  tree: (id: string) => get<ConversationTree>(`/api/conversations/${id}/tree`),
  concept: (id: string) => get<ConceptDetail>(`/api/concepts/${id}`),
  graph: () => get<PersonalGraph>('/api/graph'),
  search: (q: string) => get<Concept[]>(`/api/search?q=${encodeURIComponent(q)}`),
  renameConcept: (id: string, name: string) => send<Concept>('PATCH', `/api/concepts/${id}`, { name }),
  mergeConcept: (id: string, into: string) => send<Concept>('POST', `/api/concepts/${id}/merge`, { into }),
  deleteConcept: (id: string) => send<void>('DELETE', `/api/concepts/${id}`),
  editVisit: (id: string, edit: VisitEdit) => send<Visit>('PATCH', `/api/visits/${id}`, edit),
  deleteVisit: (id: string) => send<void>('DELETE', `/api/visits/${id}`),
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
