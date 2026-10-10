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
  /** Key points written by the model when the answer goes deep on this node; only with the opt-in setting (D17). */
  detail: string | null;
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

/** A sub-concept shown as a section of "Approfondisci" (D17): what was explained under a node. */
export interface ConceptSection {
  title: string;
  summary: string;
  detail: string | null;
  children: ConceptSection[];
}

/** One place where a concept appears (D16): which conversation, under which node, and its sub-concepts. */
export interface ConceptOccurrence extends Visit {
  conversationTitle: string;
  parentTitle: string | null;
  sections: ConceptSection[];
}

/** The "Approfondisci" page of a concept. */
export interface ConceptPage extends Concept {
  visits: ConceptOccurrence[];
}

/** Canvas settings that change what the server exposes to the model. */
export interface Settings {
  /** D17: the model may write a `detail` field (costs output tokens). Applies from the next chat. */
  detail: boolean;
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
