import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Repository } from './repository.ts';
import type {
  Concept,
  ConceptDetail,
  ConceptMatch,
  Conversation,
  ConversationTree,
  PersonalGraph,
  Visit,
} from './types.ts';
import { SCHEMA } from './schema.ts';
import { similarityKey } from './similarity.ts';

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();

function toConversation(r: Row): Conversation {
  return {
    id: r.id as string,
    title: r.title as string,
    client: (r.client as string | null) ?? null,
    currentVisitId: (r.current_visit_id as string | null) ?? null,
    startedAt: r.started_at as string,
    lastActivityAt: r.last_activity_at as string,
  };
}

function toConcept(r: Row): Concept {
  return {
    id: r.id as string,
    name: r.name as string,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
    visitCount: Number(r.visit_count ?? 0),
  };
}

function toVisit(r: Row): Visit {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    conceptId: r.concept_id as string,
    parentVisitId: (r.parent_visit_id as string | null) ?? null,
    title: r.title as string,
    summary: r.summary as string,
    excerpt: (r.excerpt as string | null) ?? null,
    seq: Number(r.seq),
    createdAt: r.created_at as string,
  };
}

const CONCEPT_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM visits v WHERE v.concept_id = c.id) AS visit_count
  FROM concepts c`;

/** Builds an FTS5 query that matches any word of at least 3 characters (trigram minimum). */
function ftsQuery(text: string): string | null {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replaceAll('"', '')}"`).join(' OR ');
}

export class SqliteRepository implements Repository {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.checkpoint();
  }

  /** Copies the WAL into the main file, so that graph.db alone is a complete backup (RNF8). */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  createConversation(input: { title: string; client: string | null }): Conversation {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare('INSERT INTO conversations (id, title, client, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.title, input.client, t, t);
    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    return r ? toConversation(r) : undefined;
  }

  listConversations(): Conversation[] {
    return this.db.prepare('SELECT * FROM conversations ORDER BY last_activity_at DESC, rowid DESC').all().map(toConversation);
  }

  setCurrentVisit(conversationId: string, visitId: string | null): void {
    this.db
      .prepare('UPDATE conversations SET current_visit_id = ?, last_activity_at = ? WHERE id = ?')
      .run(visitId, now(), conversationId);
  }

  findConceptByNorm(nameNorm: string): Concept | undefined {
    const r = this.db.prepare(`${CONCEPT_SELECT} WHERE c.name_norm = ?`).get(nameNorm);
    return r ? toConcept(r) : undefined;
  }

  getConcept(id: string): Concept | undefined {
    const r = this.db.prepare(`${CONCEPT_SELECT} WHERE c.id = ?`).get(id);
    return r ? toConcept(r) : undefined;
  }

  createConcept(input: { name: string; nameNorm: string }): Concept {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare('INSERT INTO concepts (id, name, name_norm, name_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.nameNorm, similarityKey(input.name), t, t);
    this.db.prepare('INSERT INTO concepts_fts (concept_id, name) VALUES (?, ?)').run(id, input.name);
    return this.getConcept(id)!;
  }

  deleteConcept(id: string): void {
    this.db.prepare('DELETE FROM concepts_fts WHERE concept_id = ?').run(id);
    this.db.prepare('DELETE FROM concepts WHERE id = ?').run(id);
  }

  renameConcept(id: string, name: string, nameNorm: string): void {
    this.db.prepare('UPDATE concepts SET name = ?, name_norm = ?, name_key = ? WHERE id = ?').run(name, nameNorm, similarityKey(name), id);
    this.db.prepare('UPDATE concepts_fts SET name = ? WHERE concept_id = ?').run(name, id);
  }

  reassignConcept(fromId: string, toId: string): void {
    this.db.prepare('UPDATE visits SET concept_id = ? WHERE concept_id = ?').run(toId, fromId);
    this.db.prepare('UPDATE OR IGNORE concept_links SET from_concept_id = ? WHERE from_concept_id = ?').run(toId, fromId);
    this.db.prepare('UPDATE OR IGNORE concept_links SET to_concept_id = ? WHERE to_concept_id = ?').run(toId, fromId);
    this.db
      .prepare('DELETE FROM concept_links WHERE from_concept_id = ?1 OR to_concept_id = ?1 OR from_concept_id = to_concept_id')
      .run(fromId);
    this.db
      .prepare('UPDATE concepts SET last_seen_at = MAX(last_seen_at, (SELECT last_seen_at FROM concepts WHERE id = ?1)) WHERE id = ?2')
      .run(fromId, toId);
  }

  findConceptsByName(fragment: string, limit: number): Concept[] {
    const like = `%${fragment.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return this.db
      .prepare(`${CONCEPT_SELECT} WHERE c.name LIKE ? ESCAPE '\\' ORDER BY length(c.name), c.last_seen_at DESC LIMIT ?`)
      .all(like, limit)
      .map(toConcept);
  }

  /** Columns added after the first release; databases created earlier get them on open. */
  private migrate() {
    const has = (table: string, column: string) =>
      this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has('concepts', 'name_key')) {
      this.db.exec('ALTER TABLE concepts ADD COLUMN name_key TEXT');
      const set = this.db.prepare('UPDATE concepts SET name_key = ? WHERE id = ?');
      for (const r of this.db.prepare('SELECT id, name FROM concepts').all()) set.run(similarityKey(r.name as string), r.id as string);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS concepts_key ON concepts(name_key)');
  }

  findConceptsByKey(name: string, excludeId: string): ConceptMatch[] {
    const key = similarityKey(name);
    if (!key) return [];
    return this.db
      .prepare('SELECT id, name FROM concepts WHERE name_key = ? AND id <> ?')
      .all(key, excludeId)
      .map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  similarConcepts(name: string, excludeId: string, limit: number): ConceptMatch[] {
    const q = ftsQuery(name);
    if (!q) return [];
    return this.db
      .prepare(
        `SELECT f.concept_id AS id, c.name AS name FROM concepts_fts f
         JOIN concepts c ON c.id = f.concept_id
         WHERE concepts_fts MATCH ? AND f.concept_id <> ?
         ORDER BY bm25(concepts_fts) LIMIT ?`,
      )
      .all(q, excludeId, limit)
      .map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  getConceptDetail(id: string): ConceptDetail | undefined {
    const concept = this.getConcept(id);
    if (!concept) return undefined;
    const visits = this.db
      .prepare(
        `SELECT v.*, cv.title AS conversation_title FROM visits v
         JOIN conversations cv ON cv.id = v.conversation_id
         WHERE v.concept_id = ? ORDER BY v.created_at DESC, v.rowid DESC`,
      )
      .all(id)
      .map((r) => ({ ...toVisit(r), conversationTitle: r.conversation_title as string }));
    return { ...concept, visits };
  }

  searchConcepts(query: string, limit: number): Concept[] {
    const scores = new Map<string, number>();
    const add = (id: string, score: number) => scores.set(id, (scores.get(id) ?? 0) + score);
    const q = ftsQuery(query);
    if (q) {
      this.db
        .prepare('SELECT concept_id FROM concepts_fts WHERE concepts_fts MATCH ? ORDER BY bm25(concepts_fts) LIMIT ?')
        .all(q, limit * 2)
        .forEach((r, i) => add(r.concept_id as string, 50 - i));
    }
    // Words of 4+ characters also match what was said (titles and summaries), to skip most stop words.
    const words = new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
    const bySummary = this.db.prepare(
      `SELECT concept_id, COUNT(*) AS n FROM visits
       WHERE title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' GROUP BY concept_id`,
    );
    for (const w of words) {
      const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      for (const r of bySummary.all(like, like)) add(r.concept_id as string, Math.min(Number(r.n), 5));
    }
    return [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.getConcept(id))
      .filter((c): c is Concept => c !== undefined);
  }

  neighbourConcepts(conceptId: string, limit: number): ConceptMatch[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name, COUNT(*) AS n FROM (
           SELECT v.concept_id AS other FROM visits v JOIN visits p ON p.id = v.parent_visit_id WHERE p.concept_id = ?1
           UNION ALL
           SELECT p.concept_id FROM visits v JOIN visits p ON p.id = v.parent_visit_id WHERE v.concept_id = ?1
           UNION ALL
           SELECT to_concept_id FROM concept_links WHERE from_concept_id = ?1
           UNION ALL
           SELECT from_concept_id FROM concept_links WHERE to_concept_id = ?1
         ) x JOIN concepts c ON c.id = x.other
         WHERE c.id <> ?1
         GROUP BY c.id ORDER BY n DESC, c.last_seen_at DESC LIMIT ?2`,
      )
      .all(conceptId, limit)
      .map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  rankConcepts(order: 'visits' | 'recent', limit: number): Concept[] {
    const orderBy = order === 'visits' ? 'visit_count DESC, c.last_seen_at DESC' : 'c.last_seen_at DESC, c.rowid DESC';
    return this.db.prepare(`${CONCEPT_SELECT} ORDER BY ${orderBy} LIMIT ?`).all(limit).map(toConcept);
  }

  countConcepts(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM concepts').get() as { n: number }).n);
  }

  getVisit(id: string): Visit | undefined {
    const r = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
    return r ? toVisit(r) : undefined;
  }

  createVisit(input: Omit<Visit, 'id' | 'seq' | 'createdAt'>): Visit {
    const id = randomUUID();
    const t = now();
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM visits WHERE conversation_id = ?')
      .get(input.conversationId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO visits (id, conversation_id, concept_id, parent_visit_id, title, summary, excerpt, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.conversationId, input.conceptId, input.parentVisitId, input.title, input.summary, input.excerpt, next, t);
    this.db.prepare('UPDATE concepts SET last_seen_at = ? WHERE id = ?').run(t, input.conceptId);
    return this.getVisit(id)!;
  }

  setVisitConcept(visitId: string, conceptId: string): void {
    this.db.prepare('UPDATE visits SET concept_id = ? WHERE id = ?').run(conceptId, visitId);
  }

  setVisitTitle(visitId: string, title: string): void {
    this.db.prepare('UPDATE visits SET title = ? WHERE id = ?').run(title, visitId);
  }

  setVisitSummary(visitId: string, summary: string, excerpt: string | null): void {
    this.db.prepare('UPDATE visits SET summary = ?, excerpt = ? WHERE id = ?').run(summary, excerpt, visitId);
  }

  setVisitParent(visitId: string, parentVisitId: string | null): void {
    this.db.prepare('UPDATE visits SET parent_visit_id = ? WHERE id = ?').run(parentVisitId, visitId);
  }

  reparentChildren(visitId: string, parentVisitId: string | null): void {
    this.db.prepare('UPDATE visits SET parent_visit_id = ? WHERE parent_visit_id = ?').run(parentVisitId, visitId);
  }

  deleteVisit(id: string): void {
    this.db.prepare('UPDATE conversations SET current_visit_id = NULL WHERE current_visit_id = ?').run(id);
    this.db.prepare('DELETE FROM visits WHERE id = ?').run(id);
  }

  countVisitsOfConcept(conceptId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM visits WHERE concept_id = ?').get(conceptId) as { n: number };
    return Number(r.n);
  }

  getTree(conversationId: string): ConversationTree | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const visits = this.db
      .prepare('SELECT * FROM visits WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId)
      .map(toVisit);
    return { conversation, visits };
  }

  getPersonalGraph(): PersonalGraph {
    const concepts = this.db
      .prepare(
        `SELECT c.*, COUNT(v.id) AS visit_count,
           (SELECT v2.summary FROM visits v2 WHERE v2.concept_id = c.id ORDER BY v2.created_at DESC, v2.seq DESC LIMIT 1) AS summary
         FROM concepts c JOIN visits v ON v.concept_id = c.id
         GROUP BY c.id`,
      )
      .all()
      .map((r) => ({ ...toConcept(r), summary: (r.summary as string) ?? '' }));
    // Edges come from drill-downs (parent visit -> child visit) plus explicit concept links.
    const edges = this.db
      .prepare(
        `SELECT source, target, SUM(w) AS weight FROM (
           SELECT p.concept_id AS source, v.concept_id AS target, COUNT(*) AS w
           FROM visits v JOIN visits p ON p.id = v.parent_visit_id
           WHERE p.concept_id <> v.concept_id
           GROUP BY 1, 2
           UNION ALL
           SELECT from_concept_id, to_concept_id, 1 FROM concept_links
         ) GROUP BY source, target`,
      )
      .all()
      .map((r) => ({ source: r.source as string, target: r.target as string, weight: Number(r.weight) }));
    return { concepts, edges };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }
}
