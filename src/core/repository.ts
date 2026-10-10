import type { Concept, ConceptDetail, ConceptMatch, Conversation, ConversationTree, Visit } from './types.ts';

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
  similarConcepts(name: string, excludeId: string, limit: number): ConceptMatch[];
  getConceptDetail(id: string): ConceptDetail | undefined;

  getVisit(id: string): Visit | undefined;
  createVisit(input: Omit<Visit, 'id' | 'seq' | 'createdAt'>): Visit;
  setVisitConcept(visitId: string, conceptId: string): void;
  countVisitsOfConcept(conceptId: string): number;
  getTree(conversationId: string): ConversationTree | undefined;

  transaction<T>(fn: () => T): T;
  close(): void;
}
