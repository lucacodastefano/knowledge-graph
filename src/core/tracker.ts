import { EventEmitter } from 'node:events';
import type { Repository } from './repository.ts';
import type { Concept, ConceptMatch, Conversation, Settings, Visit } from './types.ts';
import { normalizeName } from './normalize.ts';
import { restatesParent } from './similarity.ts';

export class TrackerError extends Error {}

export interface TrackNodeInput {
  title: string;
  summary: string;
  /**
   * "root", the title of a node of this conversation (its latest visit), a visit id, or "#n" for the n-th node
   * of the same batch. The MCP tool requires it (D15); internal callers may omit it for "current".
   */
  parent?: string;
  excerpt?: string;
  /** Key points, only when the canvas setting allows it (D17). */
  detail?: string;
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
  /** True when the same concept already sat under the same parent: its summary was updated, no new node (D15). */
  updated?: boolean;
  /** Possible duplicates, only for brand-new concepts. */
  similar: ConceptMatch[];
}

export type TrackerEvent =
  | { type: 'conversation.created'; conversation: Conversation }
  | { type: 'visit.created'; visit: Visit; concept: Concept }
  | { type: 'visit.relinked'; visit: Visit; concept: Concept; removedConceptId: string | null }
  | { type: 'focus.changed'; conversationId: string; visitId: string | null }
  | { type: 'visit.updated'; visit: Visit }
  | { type: 'visit.deleted'; visitId: string; conversationId: string; removedConceptId: string | null }
  | { type: 'concept.renamed'; concept: Concept }
  | { type: 'concept.merged'; fromId: string; into: Concept }
  | { type: 'concept.deleted'; conceptId: string };

export interface VisitEdit {
  title?: string;
  /** New parent: a visit of the same conversation, or null for the root. */
  parentVisitId?: string | null;
  conceptId?: string;
}

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
    const updatedVisits: Visit[] = [];

    const results = this.repo.transaction(() => {
      let current = this.requireConversation(conversationId).currentVisitId;
      const out: TrackNodeResult[] = [];

      nodes.forEach((node, index) => {
        const title = node.title.trim();
        if (!title) throw new TrackerError(`Node #${index} has an empty title`);
        const parentVisitId = this.resolveParent(conversationId, node.parent, current, out, index);
        if (parentVisitId !== null) this.rejectWrapper(nodes, index, this.repo.getVisit(parentVisitId)!.title);

        let concept: Concept | undefined;
        if (node.conceptId) {
          concept = this.repo.getConcept(node.conceptId);
          if (!concept) throw new TrackerError(`Concept ${node.conceptId} not found`);
        } else {
          concept = this.repo.findConceptByNorm(normalizeName(title));
        }
        const knownConcept = concept !== undefined;
        const visits = knownConcept ? this.repo.getTree(conversationId)!.visits : [];
        const summary = node.summary.trim();
        const excerpt = node.excerpt?.trim() || null;
        const detail = node.detail?.trim() || null;

        // Same concept under the same parent: refresh that node instead of duplicating it (D15).
        const twin = visits.find((v) => v.conceptId === concept!.id && v.parentVisitId === parentVisitId);
        if (twin) {
          this.repo.setVisitSummary(twin.id, summary, excerpt, detail ?? twin.detail);
          updatedVisits.push(this.repo.getVisit(twin.id)!);
          current = twin.id;
          out.push({ id: twin.id, conceptId: concept!.id, knownConcept, revisit: true, updated: true, similar: [] });
          return;
        }

        const revisit = visits.some((v) => v.conceptId === concept!.id);
        concept ??= this.repo.createConcept({ name: title, nameNorm: normalizeName(title) });

        const visit = this.repo.createVisit({ conversationId, conceptId: concept.id, parentVisitId, title, summary, excerpt, detail });
        created.push({ visit, concept: this.repo.getConcept(concept.id)! });
        current = visit.id;
        out.push({
          id: visit.id,
          conceptId: concept.id,
          knownConcept,
          revisit,
          similar: knownConcept ? [] : this.similar(title, concept.id),
        });
      });

      this.repo.setCurrentVisit(conversationId, current);
      return out;
    });

    for (const c of created) this.emit({ type: 'visit.created', ...c });
    for (const visit of updatedVisits) this.emit({ type: 'visit.updated', visit });
    this.emit({ type: 'focus.changed', conversationId, visitId: results.at(-1)!.id });
    return results;
  }

  /** A node that only restates its parent is refused, so its parts go straight under the parent (anti-wrapper). */
  private rejectWrapper(nodes: TrackNodeInput[], index: number, parentTitle: string) {
    const node = nodes[index];
    const parentOf = (n: TrackNodeInput) => normalizeName(n.parent ?? '');
    const own = nodes.some((n) => n.parent?.trim() === `#${index}` || parentOf(n) === normalizeName(node.title));
    const siblings = nodes.some((n, j) => j !== index && parentOf(n) === parentOf(node));
    if (!restatesParent(node.title, parentTitle, own && !siblings)) return;
    throw new TrackerError(
      `"${node.title.trim()}" restates its parent "${parentTitle}": put its parts directly under "${parentTitle}" (track "${parentTitle}" again to update its summary)`,
    );
  }

  /** Possible duplicates of a new concept: same words in another form first, then full-text neighbours. */
  similar(name: string, excludeId: string): ConceptMatch[] {
    const found = new Map<string, ConceptMatch>();
    for (const c of this.repo.findConceptsByKey(name, excludeId)) found.set(c.id, c);
    for (const c of this.repo.similarConcepts(name, excludeId, SIMILAR_LIMIT)) found.set(c.id, c);
    return [...found.values()].slice(0, SIMILAR_LIMIT);
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
    return this.resolveNode(conversationId, p).id;
  }

  /** A node of the conversation by id, or by title (latest visit with that title or concept name). */
  resolveNode(conversationId: string, ref: string): Visit {
    const visits = this.repo.getTree(conversationId)?.visits ?? [];
    const byId = visits.find((v) => v.id === ref);
    if (byId) return byId;
    const norm = normalizeName(ref);
    const byTitle = visits.findLast(
      (v) => normalizeName(v.title) === norm || normalizeName(this.repo.getConcept(v.conceptId)?.name ?? '') === norm,
    );
    if (byTitle) return byTitle;
    throw new TrackerError(`Node "${ref}" not found in this conversation: use a title from the tree, "root" or "#n"`);
  }

  /** Re-attaches a node (by id or title) under another one, or to the root (kc_move). */
  move(conversationId: string, nodeRef: string, parentRef: string): Visit {
    const node = this.resolveNode(conversationId, nodeRef);
    const parent = parentRef.trim() === 'root' ? null : this.resolveNode(conversationId, parentRef).id;
    return this.editVisit(node.id, { parentVisitId: parent });
  }

  /**
   * Renames a node (kc_rename). The new title decides its concept: an existing concept with that name is shared
   * (D1), otherwise the node's own concept is renamed when nothing else uses it, or a new one is created.
   */
  rename(conversationId: string, nodeRef: string, title: string): Visit {
    const node = this.resolveNode(conversationId, nodeRef);
    const trimmed = title.trim();
    if (!trimmed) throw new TrackerError('Empty title');
    const norm = normalizeName(trimmed);
    const existing = this.repo.findConceptByNorm(norm);
    if (existing) return this.editVisit(node.id, { title: trimmed, conceptId: existing.id });
    if (this.repo.countVisitsOfConcept(node.conceptId) === 1) {
      this.renameConcept(node.conceptId, trimmed);
      return this.editVisit(node.id, { title: trimmed });
    }
    const concept = this.repo.createConcept({ name: trimmed, nameNorm: norm });
    return this.editVisit(node.id, { title: trimmed, conceptId: concept.id });
  }

  /** Removes a node (kc_remove); its children move up to its parent. */
  remove(conversationId: string, nodeRef: string): void {
    this.deleteVisit(this.resolveNode(conversationId, nodeRef).id);
  }

  settings(): Settings {
    return { detail: this.repo.getSetting('detail') === 'on' };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.detail !== undefined) this.repo.setSetting('detail', patch.detail ? 'on' : 'off');
    return this.settings();
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

  // --- Manual corrections from the canvas (D8, RF18) ---

  private requireConcept(id: string): Concept {
    const c = this.repo.getConcept(id);
    if (!c) throw new TrackerError(`Concept ${id} not found`);
    return c;
  }

  private requireVisit(id: string): Visit {
    const v = this.repo.getVisit(id);
    if (!v) throw new TrackerError(`Node ${id} not found`);
    return v;
  }

  /**
   * Renames a concept. Nodes titled like the old name follow it, so a typo fixed once is fixed everywhere;
   * nodes with their own wording keep it. A name already taken by another concept must be merged instead.
   */
  renameConcept(conceptId: string, name: string): Concept {
    const concept = this.requireConcept(conceptId);
    const trimmed = name.trim();
    if (!trimmed) throw new TrackerError('Empty name');
    const norm = normalizeName(trimmed);
    const clash = this.repo.findConceptByNorm(norm);
    if (clash && clash.id !== conceptId) throw new TrackerError(`"${clash.name}" already exists: merge the two concepts instead`);

    const oldNorm = normalizeName(concept.name);
    const renamed: Visit[] = [];
    const updated = this.repo.transaction(() => {
      this.repo.renameConcept(conceptId, trimmed, norm);
      for (const v of this.repo.getConceptDetail(conceptId)!.visits) {
        if (normalizeName(v.title) === oldNorm && v.title !== trimmed) {
          this.repo.setVisitTitle(v.id, trimmed);
          renamed.push(this.repo.getVisit(v.id)!);
        }
      }
      return this.repo.getConcept(conceptId)!;
    });
    for (const visit of renamed) this.emit({ type: 'visit.updated', visit });
    this.emit({ type: 'concept.renamed', concept: updated });
    return updated;
  }

  /** Merges a duplicate concept into another one: every visit moves, the duplicate disappears. */
  mergeConcepts(fromId: string, intoId: string): Concept {
    this.requireConcept(fromId);
    this.requireConcept(intoId);
    if (fromId === intoId) throw new TrackerError('Cannot merge a concept into itself');
    const into = this.repo.transaction(() => {
      this.repo.reassignConcept(fromId, intoId);
      this.repo.deleteConcept(fromId);
      return this.repo.getConcept(intoId)!;
    });
    this.emit({ type: 'concept.merged', fromId, into });
    return into;
  }

  /** Deletes a concept and all its nodes, in every conversation; their children move up one level. */
  deleteConcept(conceptId: string): void {
    this.requireConcept(conceptId);
    this.repo.transaction(() => {
      for (const v of this.repo.getConceptDetail(conceptId)!.visits) this.removeVisit(v.id);
      this.repo.deleteConcept(conceptId);
    });
    this.emit({ type: 'concept.deleted', conceptId });
  }

  /** Renames a node, moves it under another parent, or links it to another concept. */
  editVisit(visitId: string, edit: VisitEdit): Visit {
    const visit = this.requireVisit(visitId);
    let removedConceptId: string | null = null;
    const updated = this.repo.transaction(() => {
      if (edit.title !== undefined) {
        const title = edit.title.trim();
        if (!title) throw new TrackerError('Empty title');
        this.repo.setVisitTitle(visitId, title);
      }
      if (edit.parentVisitId !== undefined) this.moveVisit(visit, edit.parentVisitId);
      if (edit.conceptId !== undefined && edit.conceptId !== visit.conceptId) {
        this.requireConcept(edit.conceptId);
        this.repo.setVisitConcept(visitId, edit.conceptId);
        if (this.repo.countVisitsOfConcept(visit.conceptId) === 0) {
          this.repo.deleteConcept(visit.conceptId);
          removedConceptId = visit.conceptId;
        }
      }
      return this.repo.getVisit(visitId)!;
    });
    if (removedConceptId) this.emit({ type: 'visit.relinked', visit: updated, concept: this.repo.getConcept(updated.conceptId)!, removedConceptId });
    this.emit({ type: 'visit.updated', visit: updated });
    return updated;
  }

  private moveVisit(visit: Visit, parentVisitId: string | null) {
    if (parentVisitId !== null) {
      this.requireVisitIn(visit.conversationId, parentVisitId);
      // Walk up from the new parent: reaching the node itself would create a cycle.
      for (let p: string | null = parentVisitId; p; p = this.repo.getVisit(p)!.parentVisitId) {
        if (p === visit.id) throw new TrackerError('A node cannot move under itself or one of its descendants');
      }
    }
    this.repo.setVisitParent(visit.id, parentVisitId);
  }

  /** Deletes one node; its children move up to its parent and an unused concept is dropped. */
  deleteVisit(visitId: string): void {
    const visit = this.requireVisit(visitId);
    const removedConceptId = this.repo.transaction(() => this.removeVisit(visitId));
    this.emit({ type: 'visit.deleted', visitId, conversationId: visit.conversationId, removedConceptId });
  }

  private removeVisit(visitId: string): string | null {
    const visit = this.repo.getVisit(visitId)!;
    const conversation = this.repo.getConversation(visit.conversationId)!;
    this.repo.reparentChildren(visitId, visit.parentVisitId);
    this.repo.deleteVisit(visitId);
    if (conversation.currentVisitId === visitId) this.repo.setCurrentVisit(visit.conversationId, visit.parentVisitId);
    if (this.repo.countVisitsOfConcept(visit.conceptId) > 0) return null;
    this.repo.deleteConcept(visit.conceptId);
    return visit.conceptId;
  }
}
