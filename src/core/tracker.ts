import { EventEmitter } from 'node:events';
import type { Repository } from './repository.ts';
import type { Concept, ConceptMatch, Conversation, Settings, Visit } from './types.ts';
import { normalizeName } from './normalize.ts';
import { restatesParent, sharesEnough } from './similarity.ts';
import { normalizeSources, normalizeSourceUrl } from './sources.ts';
import { applyDetailEdit, type DetailEdit, DetailEditError } from './node-edit.ts';

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
  /** URLs of web results or documents the answer on this node relies on; invalid ones are ignored. */
  sources?: string[];
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
  | { type: 'conversation.deleted'; conversationId: string; removedConceptIds: string[] }
  | { type: 'concept.renamed'; concept: Concept }
  | { type: 'concept.merged'; fromId: string; into: Concept }
  | { type: 'concept.deleted'; conceptId: string }
  | { type: 'concept.related'; from: string; to: string; related: boolean }
  | { type: 'concept.grouped'; conceptId: string; superclassId: string | null }
  | { type: 'settings.changed'; settings: Settings };

export interface VisitEdit {
  title?: string;
  summary?: string;
  /** Key points (D17); null clears them. */
  detail?: string | null;
  /** New parent: a visit of the same conversation, or null for the root. */
  parentVisitId?: string | null;
  conceptId?: string;
}

/** kc_edit: what to change in one node, without resending the rest. */
export interface NodeEdit extends DetailEdit {
  summary?: string;
  addSources?: string[];
  removeSources?: string[];
}

const SIMILAR_LIMIT = 3;
const DEFAULT_TITLE = 'Conversazione';

/**
 * Processing order of a kc_track batch: each node comes after the batch node it hangs under ("#n", or the title
 * of another node of the batch, which as the latest node with that title wins over older ones). Otherwise the
 * caller's order is kept. A cycle of parents inside the batch is an error.
 */
export function batchOrder(nodes: TrackNodeInput[]): { index: number; parentIndex: number | null }[] {
  const parentIndex = nodes.map((node, index) => {
    const p = node.parent?.trim() ?? '';
    if (p.startsWith('#')) {
      const ref = Number(p.slice(1));
      if (!/^#\d+$/.test(p) || ref >= nodes.length || ref === index) {
        throw new TrackerError(`Node #${index}: parent ${p} is not another node of this call`);
      }
      return ref;
    }
    const norm = normalizeName(p);
    if (!norm || p === 'root' || p === 'current') return null;
    const same = (j: number) => j !== index && normalizeName(nodes[j].title) === norm;
    // The latest batch node with that title before this one, else the first one after it.
    for (let j = index - 1; j >= 0; j--) if (same(j)) return j;
    for (let j = index + 1; j < nodes.length; j++) if (same(j)) return j;
    return null;
  });

  const order: { index: number; parentIndex: number | null }[] = [];
  const state = nodes.map((): 'new' | 'visiting' | 'done' => 'new');
  const place = (i: number, path: number[]): void => {
    if (state[i] === 'done') return;
    if (state[i] === 'visiting') {
      const cycle = [...path.slice(path.indexOf(i)), i].map((j) => `#${j} "${nodes[j].title.trim()}"`);
      throw new TrackerError(`Parent cycle in this call: ${cycle.join(' under ')}. Give one of them a parent outside the cycle`);
    }
    state[i] = 'visiting';
    const p = parentIndex[i];
    if (p !== null) place(p, [...path, i]);
    state[i] = 'done';
    order.push({ index: i, parentIndex: p });
  };
  nodes.forEach((_, i) => place(i, []));
  return order;
}

/** Domain service: the only place where tracking rules live. Emits an event for every change. */
export class Tracker {
  readonly events = new EventEmitter<{ change: [TrackerEvent] }>();

  readonly repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
    // One listener per open canvas socket and per MCP session: many are normal.
    this.events.setMaxListeners(0);
  }

  /** Keeps the previous value of an edited field (D16: history for a future versioning UI). */
  private keep(targetKind: 'concept' | 'visit', targetId: string, field: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) this.repo.addRevision({ targetKind, targetId, field, oldValue });
  }

  private emit(e: TrackerEvent) {
    this.events.emit('change', e);
  }

  startConversation(title: string | undefined, client: string | null): Conversation {
    const conversation = this.repo.createConversation({ title: title?.trim() || 'Conversazione', client });
    this.emit({ type: 'conversation.created', conversation });
    return conversation;
  }

  /**
   * kc_start: the map that already has this title (case, accents, plural folded), to resume instead of duplicating.
   * The default title never matches, since it names nothing.
   */
  sameTitle(title: string | undefined): Conversation | undefined {
    const t = title?.trim();
    if (!t || t === DEFAULT_TITLE) return undefined;
    return this.repo.listConversations().find((c) => normalizeName(c.title) === normalizeName(t));
  }

  /** A conversation by id, by exact title, or by a title sharing enough words (most recent first). */
  findConversation(ref: string): Conversation {
    const r = ref.trim();
    const all = this.repo.listConversations();
    const found =
      all.find((c) => c.id === r) ??
      all.find((c) => normalizeName(c.title) === normalizeName(r)) ??
      all.find((c) => sharesEnough(r, c.title));
    if (!found) throw new TrackerError(`No map matches "${r}"`);
    return found;
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

  /**
   * Adds a batch of nodes atomically: any error rolls back the whole batch. Parents may point to nodes defined
   * later in the same batch (by title or "#n"): the batch is processed parents first.
   */
  track(conversationId: string, nodes: TrackNodeInput[]): TrackNodeResult[] {
    if (nodes.length === 0) throw new TrackerError('No nodes given');
    const order = batchOrder(nodes);
    const created: { visit: Visit; concept: Concept }[] = [];
    const updatedVisits: Visit[] = [];

    const results = this.repo.transaction(() => {
      let current = this.requireConversation(conversationId).currentVisitId;
      const out: TrackNodeResult[] = new Array(nodes.length);
      const fresh: number[] = [];

      for (const { index, parentIndex } of order) {
        const node = nodes[index];
        const title = node.title.trim();
        if (!title) throw new TrackerError(`Node #${index} has an empty title`);
        const parentVisitId = parentIndex !== null ? out[parentIndex].id : this.resolveParent(conversationId, node.parent, current);
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
          this.keep('visit', twin.id, 'summary', twin.summary, summary);
          this.repo.setVisitSummary(twin.id, summary, excerpt, detail ?? twin.detail);
          // Re-tracking adds the new sources to the ones already there.
          this.repo.addVisitSources(twin.id, normalizeSources(node.sources));
          updatedVisits.push(this.repo.getVisit(twin.id)!);
          current = twin.id;
          out[index] = { id: twin.id, conceptId: concept!.id, knownConcept, revisit: true, updated: true, similar: [] };
          continue;
        }

        const revisit = visits.some((v) => v.conceptId === concept!.id);
        concept ??= this.repo.createConcept({ name: title, nameNorm: normalizeName(title) });

        const { id: visitId } = this.repo.createVisit({ conversationId, conceptId: concept.id, parentVisitId, title, summary, excerpt, detail });
        this.repo.addVisitSources(visitId, normalizeSources(node.sources));
        const visit = this.repo.getVisit(visitId)!;
        created.push({ visit, concept: this.repo.getConcept(concept.id)! });
        current = visit.id;
        out[index] = {
          id: visit.id,
          conceptId: concept.id,
          knownConcept,
          revisit,
          similar: [],
        };
        fresh.push(index);
      }

      // Possible duplicates of brand-new concepts, never the other nodes of this call or the node's own ancestors.
      const batch = new Set(out.map((r) => r.conceptId));
      for (const index of fresh) {
        const ancestors = new Set<string>();
        for (let v = this.repo.getVisit(out[index].id)?.parentVisitId; v; ) {
          const p = this.repo.getVisit(v);
          if (!p) break;
          ancestors.add(p.conceptId);
          v = p.parentVisitId;
        }
        out[index].similar = this.similar(nodes[index].title.trim(), out[index].conceptId).filter((m) => !batch.has(m.id) && !ancestors.has(m.id));
      }

      // The caller's last node is where the next topics hang.
      this.repo.setCurrentVisit(conversationId, out.at(-1)!.id);
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
    // Full-text neighbours must share more than one stray word ("event" alone is not enough).
    for (const c of this.repo.similarConcepts(name, excludeId, SIMILAR_LIMIT * 3)) if (sharesEnough(name, c.name)) found.set(c.id, c);
    return [...found.values()].slice(0, SIMILAR_LIMIT);
  }

  /** A parent outside the batch: "root", "current" (internal callers) or a node of the conversation. */
  private resolveParent(conversationId: string, parent: string | undefined, current: string | null): string | null {
    const p = parent?.trim() || 'current';
    if (p === 'root') return null;
    if (p === 'current') return current;
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

  /** Partial edit of a node (kc_edit): text replaced or appended, summary, sources; the rest stays as it is. */
  editNode(conversationId: string, nodeRef: string, edit: NodeEdit): { visit: Visit; changes: string[] } {
    const node = this.resolveNode(conversationId, nodeRef);
    const textEdit = edit.find !== undefined || edit.replace !== undefined || edit.append !== undefined || edit.under !== undefined;
    const summary = edit.summary?.trim();
    if (edit.summary !== undefined && !summary) throw new TrackerError('Empty summary');
    const add = normalizeSources(edit.addSources);
    if (!textEdit && summary === undefined && add.length === 0 && !edit.removeSources?.length) {
      throw new TrackerError('Nothing to edit: give find+replace, append, summary, add_sources or remove_sources');
    }
    const changes: string[] = [];
    const visit = this.repo.transaction(() => {
      let detail = node.detail;
      if (textEdit) {
        try {
          detail = applyDetailEdit(node.detail, edit).trim() || null;
        } catch (err) {
          if (err instanceof DetailEditError) throw new TrackerError(`"${node.title}": ${err.message}`);
          throw err;
        }
        changes.push(edit.append !== undefined ? 'text added' : 'text replaced');
      }
      const newSummary = summary ?? node.summary;
      if (summary !== undefined) changes.push('summary');
      this.keep('visit', node.id, 'summary', node.summary, newSummary);
      this.keep('visit', node.id, 'detail', node.detail, detail);
      this.repo.setVisitSummary(node.id, newSummary, node.excerpt, detail);
      if (add.length) {
        this.repo.addVisitSources(node.id, add);
        changes.push(`${add.length} source(s) added`);
      }
      for (const raw of edit.removeSources ?? []) {
        const url = normalizeSourceUrl(raw)?.url;
        const source = url ? this.repo.listConceptSources(node.conceptId).find((s) => s.url === url && s.visitIds.includes(node.id)) : undefined;
        if (!source) throw new TrackerError(`"${node.title}" does not cite ${raw}`);
        this.repo.removeVisitSource(node.id, source.id);
        changes.push('source removed');
      }
      return this.repo.getVisit(node.id)!;
    });
    this.emit({ type: 'visit.updated', visit });
    return { visit, changes };
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
    return { memory: this.repo.getSetting('memory') !== 'off' };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.memory !== undefined) this.repo.setSetting('memory', patch.memory ? 'on' : 'off');
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
      this.keep('concept', conceptId, 'name', concept.name, trimmed);
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
    const loop = (a: string, b: string) => [...this.ancestors(a)].some((x) => x === b && x !== this.repo.getSuperclass(a)?.id);
    if (loop(intoId, fromId) || loop(fromId, intoId)) throw new TrackerError('Merging would create a loop in the superclasses: ungroup one first');
    const up = this.repo.getSuperclass(fromId)?.id;
    const into = this.repo.transaction(() => {
      this.repo.reassignConcept(fromId, intoId);
      this.repo.deleteConcept(fromId);
      if (up && up !== intoId) this.pruneSuperclass(up);
      return this.repo.getConcept(intoId)!;
    });
    this.emit({ type: 'concept.merged', fromId, into });
    return into;
  }

  /** Deletes a concept and all its nodes, in every conversation; their children move up one level. */
  deleteConcept(conceptId: string): void {
    this.requireConcept(conceptId);
    const up = this.repo.getSuperclass(conceptId)?.id;
    this.repo.transaction(() => {
      for (const v of this.repo.getConceptDetail(conceptId)!.visits) this.removeVisit(v.id);
      this.repo.deleteConcept(conceptId);
      if (up && this.repo.getConcept(up)) this.pruneSuperclass(up);
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
        this.keep('visit', visitId, 'title', visit.title, title);
        this.repo.setVisitTitle(visitId, title);
      }
      if (edit.summary !== undefined || edit.detail !== undefined) {
        const summary = edit.summary?.trim() ?? visit.summary;
        const detail = edit.detail === undefined ? visit.detail : edit.detail?.trim() || null;
        this.keep('visit', visitId, 'summary', visit.summary, summary);
        this.keep('visit', visitId, 'detail', visit.detail, detail);
        this.repo.setVisitSummary(visitId, summary, visit.excerpt, detail);
      }
      if (edit.parentVisitId !== undefined) this.moveVisit(visit, edit.parentVisitId);
      if (edit.conceptId !== undefined && edit.conceptId !== visit.conceptId) {
        this.requireConcept(edit.conceptId);
        this.repo.setVisitConcept(visitId, edit.conceptId);
        if (this.isUnused(visit.conceptId)) {
          const up = this.repo.getSuperclass(visit.conceptId)?.id;
          this.repo.deleteConcept(visit.conceptId);
          if (up) this.pruneSuperclass(up);
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

  /** Draws (or, with related=false, removes) a free relation between two different concepts, with an optional label. */
  setRelation(fromId: string, toId: string, related: boolean, label?: string | null): void {
    if (fromId === toId) throw new TrackerError('A concept cannot be related to itself: use merge for the same idea');
    this.requireConcept(fromId);
    this.requireConcept(toId);
    const changed = this.repo.transaction(() =>
      related ? this.repo.addRelation(fromId, toId, label) : this.repo.removeRelation(fromId, toId),
    );
    if (!changed && !related) throw new TrackerError('Relation not found');
    if (changed) this.emit({ type: 'concept.related', from: fromId, to: toId, related });
  }

  /** Puts a concept under a superclass ("is a kind of"), or out of it with null. One superclass per concept, no cycles. */
  setSuperclass(conceptId: string, superId: string | null): void {
    this.requireConcept(conceptId);
    if (superId) {
      this.requireConcept(superId);
      if (this.ancestors(superId, true).has(conceptId)) throw new TrackerError('A concept cannot sit under itself or one of its own members');
    }
    const old = this.repo.getSuperclass(conceptId)?.id ?? null;
    if (old === (superId ?? null)) return;
    this.repo.transaction(() => {
      this.repo.setSuperclass(conceptId, superId);
      if (old) this.pruneSuperclass(old);
    });
    this.emit({ type: 'concept.grouped', conceptId, superclassId: superId });
  }

  /** Creates (or reuses, by name) a superclass and puts the given concepts under it; returns the superclass. */
  group(name: string, conceptIds: string[]): Concept {
    const title = name.trim();
    if (!title) throw new TrackerError('Empty name');
    const found = this.repo.findConceptByNorm(normalizeName(title));
    const sup = found ?? this.repo.createConcept({ name: title, nameNorm: normalizeName(title) });
    try {
      for (const id of conceptIds) if (id !== sup.id) this.setSuperclass(id, sup.id);
    } catch (err) {
      if (!found) this.repo.transaction(() => this.pruneSuperclass(sup.id));
      throw err;
    }
    if (!found && this.repo.listMembers(sup.id).length === 0) this.repo.transaction(() => this.pruneSuperclass(sup.id));
    return this.repo.getConcept(sup.id) ?? sup;
  }

  /** "Ignora" on a suggestion: it will not be offered again. */
  ignoreSuggestion(key: string) {
    let ignored: string[] = [];
    try {
      ignored = JSON.parse(this.repo.getSetting('groupIgnored') ?? '[]') as string[];
    } catch {
      // Start over from an empty list.
    }
    // A "join" key lists every concept: remember each pair, so the other concepts are still offered.
    const [sup, ids] = key.split(':');
    const keys = ids ? ids.split(',').map((id) => `${sup}:${id}`) : [key];
    this.repo.setSetting('groupIgnored', JSON.stringify([...new Set([...ignored, ...keys])]));
  }

  /** MCP entry (kc_relate): by names. A missing superclass is created; the other concepts must already exist. */
  relateByName(input: { concept: string; superclass?: string; relatedTo?: string; label?: string }): string {
    const find = (name: string) => {
      const c = this.repo.findConceptByNorm(normalizeName(name));
      if (!c) throw new TrackerError(`Concept "${name}" not found`);
      return c;
    };
    const concept = find(input.concept);
    if (input.superclass) {
      const sup = this.group(input.superclass, [concept.id]);
      return `"${concept.name}" is now under "${sup.name}"`;
    }
    if (input.relatedTo) {
      const other = find(input.relatedTo);
      this.setRelation(concept.id, other.id, true, input.label ?? null);
      return `"${concept.name}" related to "${other.name}"`;
    }
    throw new TrackerError('Give superclass or related_to');
  }

  /** Superclasses above a concept, nearest first (optionally including the concept itself). */
  private ancestors(id: string, self = false): Set<string> {
    const out = new Set<string>(self ? [id] : []);
    for (let p = this.repo.getSuperclass(id); p && !out.has(p.id); p = this.repo.getSuperclass(p.id)) out.add(p.id);
    return out;
  }

  /** A superclass nobody sits under any more, with no visits of its own, is dropped (and so on up the chain). */
  private pruneSuperclass(id: string) {
    for (let cur: string | undefined = id; cur && this.isUnused(cur); ) {
      const up: string | undefined = this.repo.getSuperclass(cur)?.id;
      this.repo.deleteConcept(cur);
      cur = up;
    }
  }

  private isUnused(conceptId: string): boolean {
    return this.repo.countVisitsOfConcept(conceptId) === 0 && this.repo.listMembers(conceptId).length === 0;
  }

  /** Removes a wrong source from a node (canvas correction); the source disappears when nothing else cites it. */
  removeVisitSource(visitId: string, sourceId: string): Visit {
    this.requireVisit(visitId);
    const removed = this.repo.transaction(() => this.repo.removeVisitSource(visitId, sourceId));
    if (!removed) throw new TrackerError(`Source ${sourceId} not found on node ${visitId}`);
    const visit = this.repo.getVisit(visitId)!;
    this.emit({ type: 'visit.updated', visit });
    return visit;
  }

  /**
   * Deletes one node and drops an unused concept. Its children move up to its parent, or with `detachChildren`
   * (the canvas) become roots of their own, like deleting the edge to each of them.
   */
  deleteVisit(visitId: string, detachChildren = false): void {
    const visit = this.requireVisit(visitId);
    const removedConceptId = this.repo.transaction(() => this.removeVisit(visitId, detachChildren));
    this.emit({ type: 'visit.deleted', visitId, conversationId: visit.conversationId, removedConceptId });
  }

  /** Deletes a conversation's map; concepts used nowhere else go too, the others stay in the personal graph. */
  deleteConversation(conversationId: string): void {
    this.requireConversation(conversationId);
    const removedConceptIds = this.repo.transaction(() => {
      const removed: string[] = [];
      for (const v of this.repo.getTree(conversationId)?.visits ?? []) {
        const gone = this.removeVisit(v.id, true);
        if (gone) removed.push(gone);
      }
      this.repo.deleteConversation(conversationId);
      return removed;
    });
    this.emit({ type: 'conversation.deleted', conversationId, removedConceptIds });
  }

  /**
   * Puts back a node deleted from the canvas (undo): same text, parent and children. The concept is the original one
   * if it survived, otherwise it is recreated by name (the canvas re-applies its relations and superclass).
   */
  restoreVisit(input: { conversationId: string; conceptId: string; conceptName: string; parentVisitId: string | null; childIds: string[]; title: string; summary: string; excerpt: string | null; detail: string | null }): Visit {
    this.requireConversation(input.conversationId);
    if (input.parentVisitId !== null) this.requireVisitIn(input.conversationId, input.parentVisitId);
    const visit = this.repo.transaction(() => {
      const concept =
        this.repo.getConcept(input.conceptId) ??
        this.repo.findConceptByNorm(normalizeName(input.conceptName)) ??
        this.repo.createConcept({ name: input.conceptName, nameNorm: normalizeName(input.conceptName) });
      const created = this.repo.createVisit({ conversationId: input.conversationId, conceptId: concept.id, parentVisitId: input.parentVisitId, title: input.title, summary: input.summary, excerpt: input.excerpt, detail: input.detail });
      for (const id of input.childIds) {
        const child = this.repo.getVisit(id);
        if (child && child.conversationId === input.conversationId) this.repo.setVisitParent(id, created.id);
      }
      return this.repo.getVisit(created.id)!;
    });
    this.emit({ type: 'visit.created', visit, concept: this.repo.getConcept(visit.conceptId)! });
    return visit;
  }

  private removeVisit(visitId: string, detachChildren = false): string | null {
    const visit = this.repo.getVisit(visitId)!;
    const conversation = this.repo.getConversation(visit.conversationId)!;
    this.repo.reparentChildren(visitId, detachChildren ? null : visit.parentVisitId);
    this.repo.deleteVisit(visitId);
    if (conversation.currentVisitId === visitId) this.repo.setCurrentVisit(visit.conversationId, visit.parentVisitId);
    if (!this.isUnused(visit.conceptId)) return null;
    const up = this.repo.getSuperclass(visit.conceptId)?.id;
    this.repo.deleteConcept(visit.conceptId);
    if (up) this.pruneSuperclass(up);
    return visit.conceptId;
  }
}
