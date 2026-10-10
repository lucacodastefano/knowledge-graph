import type {
  Concept,
  ConceptDetail,
  ConceptMatch,
  ConceptSource,
  Conversation,
  ConversationTree,
  PersonalGraph,
  Revision,
  Visit,
} from './types.ts';

/**
 * Storage boundary. Everything above this interface is storage-agnostic, so the
 * SQLite implementation can be swapped for a graph database later (D12).
 */
export interface Repository {
  createConversation(input: { title: string; client: string | null }): Conversation;
  getConversation(id: string): Conversation | undefined;
  listConversations(): Conversation[];
  setCurrentVisit(conversationId: string, visitId: string | null): void;

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

  /** Links normalized sources to a visit; a URL already stored is reused (dedup), a link already there is kept. */
  addVisitSources(visitId: string, sources: { url: string; domain: string }[]): void;
  /** Unlinks a source from a visit and drops the source if nothing cites it any more. False if it was not linked. */
  removeVisitSource(visitId: string, sourceId: string): boolean;
  /** Sources of every visit of a concept, each once with the visits citing it, newest first. */
  listConceptSources(conceptId: string): ConceptSource[];

  addRevision(revision: Omit<Revision, 'createdAt'>): void;
  listRevisions(targetKind: Revision['targetKind'], targetId: string): Revision[];

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;

  transaction<T>(fn: () => T): T;
  close(): void;
}
