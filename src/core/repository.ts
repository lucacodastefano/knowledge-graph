import type {
  Concept,
  ConceptDetail,
  ConceptMatch,
  ConceptSource,
  Conversation,
  ConversationTree,
  PersonalGraph,
  TextHit,
  Revision,
  ToolCall,
  GraphSnapshot,
  Visit,
} from './types.ts';

/**
 * Storage boundary. Everything above this interface is storage-agnostic, so the
 * SQLite implementation can be swapped for a graph database later (D12).
 */
/** A point the user chose on the canvas (node position, or bend offset of a relation). */
export interface LayoutEntry {
  kind: 'visit' | 'relation';
  id: string;
  x: number;
  y: number;
}

export interface Repository {
  createConversation(input: { title: string; client: string | null }): Conversation;
  getConversation(id: string): Conversation | undefined;
  listConversations(): Conversation[];
  setCurrentVisit(conversationId: string, visitId: string | null): void;
  /** Deletes a conversation row; its visits must already be gone. */
  deleteConversation(id: string): void;

  findConceptByNorm(nameNorm: string): Concept | undefined;
  getConcept(id: string): Concept | undefined;
  createConcept(input: { name: string; nameNorm: string }): Concept;
  deleteConcept(id: string): void;
  renameConcept(id: string, name: string, nameNorm: string): void;
  /** Moves every visit and link of one concept onto another; the source concept is left without visits. */
  reassignConcept(fromId: string, toId: string): void;
  /** Concepts whose name contains the fragment (any length, unlike full-text search), shortest first. */
  findConceptsByName(fragment: string, limit: number): Concept[];
  /** Other concepts whose name has the same significant words (plurals, articles and order folded). */
  findConceptsByKey(name: string, excludeId: string): ConceptMatch[];
  similarConcepts(name: string, excludeId: string, limit: number): ConceptMatch[];
  getConceptDetail(id: string): ConceptDetail | undefined;
  /** Concepts matching a free-text query on names, visit titles and summaries, best first. */
  searchConcepts(query: string, limit: number): Concept[];
  /** Nodes of every map whose title, summary or full detail contains the words, best first (one hit per node). */
  searchText(query: string, limit: number): TextHit[];
  /** Concepts reached from or leading to this one through drill-downs, most frequent first. */
  neighbourConcepts(conceptId: string, limit: number): ConceptMatch[];
  rankConcepts(order: 'visits' | 'recent', limit: number): Concept[];
  countConcepts(): number;

  getVisit(id: string): Visit | undefined;
  createVisit(input: Omit<Visit, 'id' | 'seq' | 'createdAt' | 'sourceCount'>): Visit;
  setVisitConcept(visitId: string, conceptId: string): void;
  setVisitTitle(visitId: string, title: string): void;
  setVisitSummary(visitId: string, summary: string, excerpt: string | null, detail: string | null): void;
  setVisitParent(visitId: string, parentVisitId: string | null): void;
  /** Re-attaches the children of a visit to another parent (null = root). */
  reparentChildren(visitId: string, parentVisitId: string | null): void;
  /** Deletes a visit with its source links; sources nobody cites any more go too. */
  deleteVisit(id: string): void;
  countVisitsOfConcept(conceptId: string): number;
  getTree(conversationId: string): ConversationTree | undefined;
  getPersonalGraph(): PersonalGraph;
  layoutEntries(): LayoutEntry[];
  /** Saves points the user chose; an entry without coordinates is forgotten. */
  setLayout(entries: (Pick<LayoutEntry, 'kind' | 'id'> & Partial<LayoutEntry>)[]): void;

  /** Links normalized sources to a visit; a URL already stored is reused (dedup), a link already there is kept. */
  addVisitSources(visitId: string, sources: { url: string; domain: string }[]): void;
  /** Unlinks a source from a visit and drops the source if nothing cites it any more. False if it was not linked. */
  removeVisitSource(visitId: string, sourceId: string): boolean;
  /** Sources of every visit of a concept, each once with the visits citing it, newest first. */
  listConceptSources(conceptId: string): ConceptSource[];

  /** Adds a free relation between two concepts, or updates its label; false if nothing changed. */
  addRelation(fromId: string, toId: string, label?: string | null): boolean;
  /** Removes the relation between two concepts, whichever direction it was drawn; false if there was none. */
  removeRelation(aId: string, bId: string): boolean;
  listRelated(conceptId: string): (ConceptMatch & { label?: string })[];
  /** Makes `parentId` the one superclass of a concept, replacing any previous one; null removes it. */
  setSuperclass(childId: string, parentId: string | null): void;
  getSuperclass(conceptId: string): ConceptMatch | undefined;
  /** Concepts with a visit at the top of a conversation and no superclass: what could be grouped. */
  listRootConcepts(): ConceptMatch[];
  /** Concepts that group others. */
  listSuperclasses(): ConceptMatch[];
  /** Concepts directly under a superclass, by name. */
  listMembers(superId: string): ConceptMatch[];

  /** Metrics (core/metrics.ts): one row per MCP tool call, and the raw graph facts the quality charts are computed from. */
  recordToolCall(call: ToolCall): void;
  listToolCalls(since?: string): ToolCall[];
  /** Row counts the metering compares before and after a call to see what it created or changed. */
  counters(): { visits: number; revisions: number };
  graphSnapshot(): GraphSnapshot;

  addRevision(revision: Omit<Revision, 'createdAt'>): void;
  listRevisions(targetKind: Revision['targetKind'], targetId: string): Revision[];

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;

  transaction<T>(fn: () => T): T;
  close(): void;
}
