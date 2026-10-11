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
  /** Concepts joined to this one by a free relation drawn on the canvas. */
  related: (ConceptMatch & { label?: string })[];
  /** The one superclass this concept sits under ("is a kind of"), and the concepts it groups. */
  superclass: ConceptMatch | null;
  members: ConceptMatch[];
}

/** Canvas settings that change what the server exposes to the model. */
export interface Settings {
  /** D19: kc_start carries a compact profile of the user's graph and the model recalls known topics on its own. Default on. */
  memory: boolean;
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
  /** Conversations where it appears, the one with most visits first. */
  conversationIds: string[];
  /** The one superclass above it, if any: groups colour and place the personal graph. */
  superclassId: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** How many times the user went from source to target. */
  weight: number;
  /** A free relation drawn by the user between two different concepts. */
  relation?: boolean;
  label?: string;
}

/** The personal graph (D2): every concept ever explored, linked by the drill-downs that connected them. */
export interface PersonalGraph {
  concepts: GraphConcept[];
  edges: GraphEdge[];
  /** Conversations with at least one concept, most recent first. */
  conversations: { id: string; title: string }[];
}

/** A free relation between two different concepts (not the same idea: that is "Unisci a…"). */
export interface ConceptRelation {
  from: string;
  to: string;
  label?: string;
}

export interface ConversationTree {
  conversation: Conversation;
  visits: Visit[];
  /** Free relations between concepts that both appear in this conversation. */
  relations: ConceptRelation[];
}

/** A probable grouping the canvas offers with one click (zero tokens): concepts sharing a word, or joining an existing superclass. */
export interface GroupSuggestion {
  key: string;
  /** Proposed superclass name (editable). */
  name: string;
  concepts: ConceptMatch[];
  /** Set when the concepts would join an existing superclass. */
  into?: ConceptMatch;
}

/** One MCP tool call as logged by the server (metrics). Sizes are characters of the JSON/text exchanged with the model. */
export interface ToolCall {
  at: string;
  tool: string;
  conversationId: string | null;
  argChars: number;
  resultChars: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  nodesCreated: number;
  nodesChanged: number;
  /** kc_recall / kc_read: whether the graph had something to return; null for the other tools. */
  hit: boolean | null;
}

/** Raw facts about the graph, enough to compute growth and quality charts without more queries. */
export interface GraphSnapshot {
  conversations: { id: string; at: string }[];
  concepts: { id: string; name: string; at: string; hasSuperclass: boolean }[];
  visits: { id: string; conversationId: string; conceptId: string; parentVisitId: string | null; at: string; hasDetail: boolean; sourceCount: number }[];
  /** Creation time of every relation and superclass link ('' for those that predate the metrics). */
  relationTimes: string[];
}
