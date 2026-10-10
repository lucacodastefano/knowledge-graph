export interface Conversation {
  id: string;
  title: string;
  client: string | null;
  currentVisitId: string | null;
  startedAt: string;
  lastActivityAt: string;
}

export interface Concept {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  visitCount: number;
}

export interface Visit {
  id: string;
  conversationId: string;
  conceptId: string;
  parentVisitId: string | null;
  title: string;
  summary: string;
  excerpt: string | null;
  seq: number;
  createdAt: string;
}

export interface ConceptMatch {
  id: string;
  name: string;
}

export interface ConceptDetail extends Concept {
  visits: (Visit & { conversationTitle: string })[];
}

export interface GraphConcept extends Concept {
  /** Summary of the most recent visit, for the hover preview. */
  summary: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** How many times the user went from source to target. */
  weight: number;
}

/** The personal graph (D2): every concept ever explored, linked by the drill-downs that connected them. */
export interface PersonalGraph {
  concepts: GraphConcept[];
  edges: GraphEdge[];
}

export interface ConversationTree {
  conversation: Conversation;
  visits: Visit[];
}
