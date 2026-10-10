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
  /** How many sources (cited URLs) support this node: for the badge on the canvas node. */
  sourceCount: number;
}

/** A web page or document the model cited for a node, stored once per normalized URL. */
export interface Source {
  id: string;
  /** Normalized: no utm_* parameters, #fragment or trailing slash. */
  url: string;
  /** Host without "www.". */
  domain: string;
  firstSeen: string;
}

/** A source of a concept, with the nodes (visits) of that concept it is linked to. */
export interface ConceptSource extends Source {
  visitIds: string[];
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
  /** The visit shown as this section. */
  id: string;
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
  /** Sources of every visit of the concept, each once, newest first. */
  sources: ConceptSource[];
}

/** Canvas settings that change what the server exposes to the model. */
export interface Settings {
  /** D17: the model may write a `detail` field (costs output tokens). Applies at once, also to open chats. */
  detail: boolean;
}

/** A previous value kept before an edit (D16); no UI yet. */
export interface Revision {
  targetKind: 'concept' | 'visit';
  targetId: string;
  field: string;
  oldValue: string | null;
  createdAt: string;
}

export interface GraphConcept extends Concept {
  /** Summary of the most recent visit, for the hover preview. */
  summary: string;
  /** Distinct sources over all its visits: for the "solo concetti con fonti" filter. */
  sourceCount: number;
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
