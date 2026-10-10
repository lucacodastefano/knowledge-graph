import { EventEmitter } from 'node:events';
import type { Repository } from './repository.ts';
import type { Concept, ConceptMatch, Conversation, Visit } from './types.ts';
import { normalizeName } from './normalize.ts';

export class TrackerError extends Error {}

export interface TrackNodeInput {
  title: string;
  summary: string;
  /** "current" (default), "root", an existing visit id, or "#n" for the n-th node of the same batch. */
  parent?: string;
  excerpt?: string;
  /** Link directly to a known concept instead of matching by name. */
  conceptId?: string;
}

export interface TrackNodeResult {
  id: string;
  conceptId: string;
  /** True when the concept already existed in the personal graph. */
  knownConcept: boolean;
  /** True when the concept was already visited earlier in this conversation (dashed cross-link). */
  revisit: boolean;
  /** Possible duplicates, only for brand-new concepts. */
  similar: ConceptMatch[];
}

export type TrackerEvent =
  | { type: 'conversation.created'; conversation: Conversation }
  | { type: 'visit.created'; visit: Visit; concept: Concept }
  | { type: 'visit.relinked'; visit: Visit; concept: Concept; removedConceptId: string | null }
  | { type: 'focus.changed'; conversationId: string; visitId: string | null };

const SIMILAR_LIMIT = 3;

/** Domain service: the only place where tracking rules live. Emits an event for every change. */
export class Tracker {
  readonly events = new EventEmitter<{ change: [TrackerEvent] }>();

  readonly repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  private emit(e: TrackerEvent) {
    this.events.emit('change', e);
  }

  startConversation(title: string | undefined, client: string | null): Conversation {
    const conversation = this.repo.createConversation({ title: title?.trim() || 'Conversazione', client });
    this.emit({ type: 'conversation.created', conversation });
    return conversation;
  }

  requireConversation(id: string): Conversation {
    const c = this.repo.getConversation(id);
    if (!c) throw new TrackerError(`Conversation ${id} not found`);
    return c;
  }

  private requireVisitIn(conversationId: string, visitId: string): Visit {
    const v = this.repo.getVisit(visitId);
    if (!v || v.conversationId !== conversationId) throw new TrackerError(`Node ${visitId} not found in this conversation`);
    return v;
  }

  track(conversationId: string, nodes: TrackNodeInput[]): TrackNodeResult[] {
    if (nodes.length === 0) throw new TrackerError('No nodes given');
    const created: { visit: Visit; concept: Concept }[] = [];

    const results = this.repo.transaction(() => {
      let current = this.requireConversation(conversationId).currentVisitId;
      const out: TrackNodeResult[] = [];

      nodes.forEach((node, index) => {
        const title = node.title.trim();
        if (!title) throw new TrackerError(`Node #${index} has an empty title`);
        const parentVisitId = this.resolveParent(conversationId, node.parent, current, out, index);

        let concept: Concept | undefined;
        if (node.conceptId) {
          concept = this.repo.getConcept(node.conceptId);
          if (!concept) throw new TrackerError(`Concept ${node.conceptId} not found`);
        } else {
          concept = this.repo.findConceptByNorm(normalizeName(title));
        }
        const knownConcept = concept !== undefined;
        const revisit =
          knownConcept && this.repo.getTree(conversationId)!.visits.some((v) => v.conceptId === concept!.id);
        concept ??= this.repo.createConcept({ name: title, nameNorm: normalizeName(title) });

        const visit = this.repo.createVisit({
          conversationId,
          conceptId: concept.id,
          parentVisitId,
          title,
          summary: node.summary.trim(),
          excerpt: node.excerpt?.trim() || null,
        });
        created.push({ visit, concept: this.repo.getConcept(concept.id)! });
        current = visit.id;
        out.push({
          id: visit.id,
          conceptId: concept.id,
          knownConcept,
          revisit,
          similar: knownConcept ? [] : this.repo.similarConcepts(title, concept.id, SIMILAR_LIMIT),
        });
      });

      this.repo.setCurrentVisit(conversationId, current);
      return out;
    });

    for (const c of created) this.emit({ type: 'visit.created', ...c });
    this.emit({ type: 'focus.changed', conversationId, visitId: results.at(-1)!.id });
    return results;
  }

  private resolveParent(
    conversationId: string,
    parent: string | undefined,
    current: string | null,
    batch: TrackNodeResult[],
    index: number,
  ): string | null {
    const p = parent?.trim() || 'current';
    if (p === 'root') return null;
    if (p === 'current') return current;
    if (p.startsWith('#')) {
      const ref = Number(p.slice(1));
      if (!Number.isInteger(ref) || ref < 0 || ref >= index) {
        throw new TrackerError(`Node #${index}: parent ${p} must reference an earlier node of the same batch`);
      }
      return batch[ref].id;
    }
    return this.requireVisitIn(conversationId, p).id;
  }

  focus(conversationId: string, visitId: string | null): void {
    this.requireConversation(conversationId);
    if (visitId !== null) this.requireVisitIn(conversationId, visitId);
    this.repo.setCurrentVisit(conversationId, visitId);
    this.emit({ type: 'focus.changed', conversationId, visitId });
  }

  /** Re-attaches a node to an existing concept; the old concept is dropped if nothing else uses it. */
  link(conversationId: string, visitId: string, conceptId: string): Visit {
    const visit = this.requireVisitIn(conversationId, visitId);
    const concept = this.repo.getConcept(conceptId);
    if (!concept) throw new TrackerError(`Concept ${conceptId} not found`);
    if (visit.conceptId === conceptId) return visit;

    let removedConceptId: string | null = null;
    const updated = this.repo.transaction(() => {
      this.repo.setVisitConcept(visitId, conceptId);
      if (this.repo.countVisitsOfConcept(visit.conceptId) === 0) {
        this.repo.deleteConcept(visit.conceptId);
        removedConceptId = visit.conceptId;
      }
      return this.repo.getVisit(visitId)!;
    });
    this.emit({ type: 'visit.relinked', visit: updated, concept: this.repo.getConcept(conceptId)!, removedConceptId });
    return updated;
  }
}
