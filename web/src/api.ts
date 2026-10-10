import type { ConceptDetail, Conversation, ConversationTree, PersonalGraph, Visit } from '../../src/core/types.ts';
import type { TrackerEvent } from '../../src/core/tracker.ts';

export type { ConceptDetail, Conversation, ConversationTree, PersonalGraph, TrackerEvent, Visit };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  conversations: () => get<Conversation[]>('/api/conversations'),
  tree: (id: string) => get<ConversationTree>(`/api/conversations/${id}/tree`),
  concept: (id: string) => get<ConceptDetail>(`/api/concepts/${id}`),
  graph: () => get<PersonalGraph>('/api/graph'),
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
