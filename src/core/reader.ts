import type { Repository } from './repository.ts';
import type { Concept, ConceptPage, ConceptSection, Visit } from './types.ts';
import { normalizeName } from './normalize.ts';
import { TrackerError } from './tracker.ts';

/** What the user already knows about a concept (RF8). Kept compact: it is sent to the model. */
export interface RecalledConcept {
  id: string;
  name: string;
  /** How many times it was explored, across all conversations. */
  seen: number;
  /** Date (YYYY-MM-DD) of the last time it came up. */
  last: string;
  /** Most recent distinct summaries of what was explained. */
  notes: string[];
  /** Concepts explored right before or after it. */
  near: string[];
}

export interface Profile {
  concepts: number;
  /** Most explored concepts, as "name ×visits". */
  top: string[];
  recent: string[];
  conversations: { id: string; title: string; last: string; nodes: number }[];
}

const RECALL_LIMIT = 5;
/** Sub-concept levels shown as sections in "Approfondisci" (D17). */
const SECTION_DEPTH = 2;
const NOTES_PER_CONCEPT = 3;
const NEAR_PER_CONCEPT = 5;
const NOTE_MAX = 300;
const PROFILE_LIMIT = 10;
const PROFILE_CONVERSATIONS = 5;
const SEARCH_LIMIT = 20;

const day = (iso: string) => iso.slice(0, 10);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Read side of the domain (D5): lets the model ask what the user already explored. Never writes. */
export class Reader {
  readonly repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  recall(query: string): RecalledConcept[] {
    const q = query.trim();
    if (!q) throw new TrackerError('Empty query');
    const found = new Map<string, Concept>();
    const exact = this.repo.findConceptByNorm(normalizeName(q));
    if (exact) found.set(exact.id, exact);
    for (const c of this.repo.searchConcepts(q, RECALL_LIMIT)) found.set(c.id, c);

    return [...found.values()].slice(0, RECALL_LIMIT).map((c) => {
      const detail = this.repo.getConceptDetail(c.id)!;
      const notes = [...new Set(detail.visits.map((v) => v.summary).filter(Boolean))]
        .slice(0, NOTES_PER_CONCEPT)
        .map((s) => clip(s, NOTE_MAX));
      return {
        id: c.id,
        name: c.name,
        seen: c.visitCount,
        last: day(c.lastSeenAt),
        notes,
        near: this.repo.neighbourConcepts(c.id, NEAR_PER_CONCEPT).map((n) => n.name),
      };
    });
  }

  /** "Approfondisci": every occurrence of a concept with its parent and its sub-concepts as sections (D16, D17). */
  conceptPage(conceptId: string): ConceptPage | undefined {
    const detail = this.repo.getConceptDetail(conceptId);
    if (!detail) return undefined;
    const trees = new Map<string, Visit[]>();
    const visitsOf = (conversationId: string) => {
      if (!trees.has(conversationId)) trees.set(conversationId, this.repo.getTree(conversationId)?.visits ?? []);
      return trees.get(conversationId)!;
    };
    return {
      ...detail,
      visits: detail.visits.map((v) => {
        const all = visitsOf(v.conversationId);
        const sections = (parentId: string, depth: number): ConceptSection[] =>
          depth === 0
            ? []
            : all
                .filter((c) => c.parentVisitId === parentId)
                .map((c) => ({ title: c.title, summary: c.summary, detail: c.detail, children: sections(c.id, depth - 1) }));
        return {
          ...v,
          parentTitle: all.find((p) => p.id === v.parentVisitId)?.title ?? null,
          sections: sections(v.id, SECTION_DEPTH),
        };
      }),
    };
  }

  /**
   * Compact indented outline of a conversation (RF9): one line per node with its id,
   * so the model can kc_focus on it. Defaults to the most recent conversation.
   */
  tree(conversationId: string | null, withSummaries: boolean, compact = false): string {
    const id = conversationId ?? this.repo.listConversations()[0]?.id;
    if (!id) return 'No conversations yet.';
    const tree = this.repo.getTree(id);
    if (!tree) throw new TrackerError(`Conversation ${id} not found`);

    const { conversation, visits } = tree;
    if (compact && visits.length === 0) return 'Tree: empty';
    const children = new Map<string | null, Visit[]>();
    const ids = new Set(visits.map((v) => v.id));
    for (const v of visits) {
      const parent = v.parentVisitId && ids.has(v.parentVisitId) ? v.parentVisitId : null;
      children.set(parent, [...(children.get(parent) ?? []), v]);
    }

    // Compact: the outline returned after kc_start/kc_track, titles only, so the model sees where it is (D15).
    const lines = compact
      ? ['Tree:']
      : [`${conversation.title} [${conversation.id}] ${day(conversation.lastActivityAt)}, ${visits.length} nodes`];
    const walk = (parent: string | null, depth: number) => {
      for (const v of children.get(parent) ?? []) {
        const current = v.id === conversation.currentVisitId ? ' *current' : '';
        const summary = withSummaries && v.summary ? `: ${v.summary}` : '';
        lines.push(compact ? `${'  '.repeat(depth)}- ${v.title}` : `${'  '.repeat(depth)}- ${v.title} [${v.id}]${current}${summary}`);
        walk(v.id, depth + 1);
      }
    };
    walk(null, 0);
    return lines.join('\n');
  }

  /** Most explored and most recent themes, plus the last conversations (RF10). */
  profile(): Profile {
    return {
      concepts: this.repo.countConcepts(),
      top: this.repo.rankConcepts('visits', PROFILE_LIMIT).map((c) => `${c.name} ×${c.visitCount}`),
      recent: this.repo.rankConcepts('recent', PROFILE_LIMIT).map((c) => c.name),
      conversations: this.repo
        .listConversations()
        .map((c) => ({ id: c.id, title: c.title, last: day(c.lastActivityAt), nodes: this.repo.getTree(c.id)!.visits.length }))
        .filter((c) => c.nodes > 0)
        .slice(0, PROFILE_CONVERSATIONS),
    };
  }

  /** Node search for the canvas (RF17): exact name, then names containing the text, then what was said. */
  search(query: string): Concept[] {
    const q = query.trim();
    if (!q) return [];
    const found = new Map<string, Concept>();
    const exact = this.repo.findConceptByNorm(normalizeName(q));
    if (exact) found.set(exact.id, exact);
    for (const c of this.repo.findConceptsByName(q, SEARCH_LIMIT)) found.set(c.id, c);
    for (const c of this.repo.searchConcepts(q, SEARCH_LIMIT)) found.set(c.id, c);
    return [...found.values()].slice(0, SEARCH_LIMIT);
  }
}
