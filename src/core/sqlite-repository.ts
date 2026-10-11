import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { LayoutEntry, Repository } from './repository.ts';
import type {
  Concept,
  ConceptDetail,
  ConceptMatch,
  ConceptSource,
  Conversation,
  ConversationTree,
  PersonalGraph,
  Revision,
  ToolCall,
  GraphSnapshot,
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
    detail: (r.detail as string | null) ?? null,
    seq: Number(r.seq),
    createdAt: r.created_at as string,
    sourceCount: Number(r.source_count ?? 0),
  };
}

/** Visits with their number of sources (the canvas badge). */
const VISIT_SELECT = `
  SELECT v.*, (SELECT COUNT(*) FROM visit_sources vs WHERE vs.visit_id = v.id) AS source_count
  FROM visits v`;

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
    // One superclass per concept: the target keeps its own if it has one.
    if (this.getSuperclass(toId)) this.db.prepare(`DELETE FROM concept_links WHERE kind = 'is_a' AND from_concept_id = ?`).run(fromId);
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
    if (!has('concept_links', 'label')) this.db.exec('ALTER TABLE concept_links ADD COLUMN label TEXT');
    if (!has('visits', 'detail')) this.db.exec('ALTER TABLE visits ADD COLUMN detail TEXT');
    if (!has('concept_links', 'created_at')) this.db.exec('ALTER TABLE concept_links ADD COLUMN created_at TEXT');
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
        `SELECT v.*, cv.title AS conversation_title,
           (SELECT COUNT(*) FROM visit_sources vs WHERE vs.visit_id = v.id) AS source_count
         FROM visits v JOIN conversations cv ON cv.id = v.conversation_id
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
    const r = this.db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(id);
    return r ? toVisit(r) : undefined;
  }

  createVisit(input: Omit<Visit, 'id' | 'seq' | 'createdAt' | 'sourceCount'>): Visit {
    const id = randomUUID();
    const t = now();
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM visits WHERE conversation_id = ?')
      .get(input.conversationId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO visits (id, conversation_id, concept_id, parent_visit_id, title, summary, excerpt, detail, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.conversationId, input.conceptId, input.parentVisitId, input.title, input.summary, input.excerpt, input.detail, next, t);
    this.db.prepare('UPDATE concepts SET last_seen_at = ? WHERE id = ?').run(t, input.conceptId);
    return this.getVisit(id)!;
  }

  setVisitConcept(visitId: string, conceptId: string): void {
    this.db.prepare('UPDATE visits SET concept_id = ? WHERE id = ?').run(conceptId, visitId);
  }

  setVisitTitle(visitId: string, title: string): void {
    this.db.prepare('UPDATE visits SET title = ? WHERE id = ?').run(title, visitId);
  }

  setVisitSummary(visitId: string, summary: string, excerpt: string | null, detail: string | null): void {
    this.db.prepare('UPDATE visits SET summary = ?, excerpt = ?, detail = ? WHERE id = ?').run(summary, excerpt, detail, visitId);
  }

  setVisitParent(visitId: string, parentVisitId: string | null): void {
    this.db.prepare('UPDATE visits SET parent_visit_id = ? WHERE id = ?').run(parentVisitId, visitId);
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  reparentChildren(visitId: string, parentVisitId: string | null): void {
    this.db.prepare('UPDATE visits SET parent_visit_id = ? WHERE parent_visit_id = ?').run(parentVisitId, visitId);
  }

  deleteVisit(id: string): void {
    this.db.prepare('UPDATE conversations SET current_visit_id = NULL WHERE current_visit_id = ?').run(id);
    this.db.prepare('DELETE FROM visits WHERE id = ?').run(id);
    this.dropOrphanSources();
  }

  /** Sources no node cites any more (their last visit was deleted or unlinked). */
  private dropOrphanSources() {
    this.db.prepare('DELETE FROM sources WHERE NOT EXISTS (SELECT 1 FROM visit_sources vs WHERE vs.source_id = sources.id)').run();
  }

  addVisitSources(visitId: string, sources: { url: string; domain: string }[]): void {
    const insert = this.db.prepare('INSERT INTO sources (id, url, domain, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO NOTHING');
    const find = this.db.prepare('SELECT id FROM sources WHERE url = ?');
    const link = this.db.prepare('INSERT OR IGNORE INTO visit_sources (visit_id, source_id) VALUES (?, ?)');
    for (const s of sources) {
      insert.run(randomUUID(), s.url, s.domain, now());
      link.run(visitId, (find.get(s.url) as { id: string }).id);
    }
  }

  removeVisitSource(visitId: string, sourceId: string): boolean {
    const { changes } = this.db.prepare('DELETE FROM visit_sources WHERE visit_id = ? AND source_id = ?').run(visitId, sourceId);
    this.dropOrphanSources();
    return Number(changes) > 0;
  }

  listConceptSources(conceptId: string): ConceptSource[] {
    return this.db
      .prepare(
        `SELECT s.*, group_concat(vs.visit_id) AS visit_ids FROM sources s
         JOIN visit_sources vs ON vs.source_id = s.id
         JOIN visits v ON v.id = vs.visit_id
         WHERE v.concept_id = ?
         GROUP BY s.id ORDER BY s.first_seen DESC, s.rowid DESC`,
      )
      .all(conceptId)
      .map((r) => ({
        id: r.id as string,
        url: r.url as string,
        domain: r.domain as string,
        firstSeen: r.first_seen as string,
        visitIds: (r.visit_ids as string).split(','),
      }));
  }

  countVisitsOfConcept(conceptId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM visits WHERE concept_id = ?').get(conceptId) as { n: number };
    return Number(r.n);
  }

  getTree(conversationId: string): ConversationTree | undefined {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return undefined;
    const visits = this.db
      .prepare(`${VISIT_SELECT} WHERE v.conversation_id = ? ORDER BY v.seq`)
      .all(conversationId)
      .map(toVisit);
    const relations = this.db
      .prepare(
        `SELECT l.from_concept_id AS f, l.to_concept_id AS t, l.label FROM concept_links l
         WHERE l.kind = 'related'
           AND EXISTS (SELECT 1 FROM visits v WHERE v.conversation_id = ?1 AND v.concept_id = l.from_concept_id)
           AND EXISTS (SELECT 1 FROM visits v WHERE v.conversation_id = ?1 AND v.concept_id = l.to_concept_id)`,
      )
      .all(conversationId)
      .map((r) => ({ from: r.f as string, to: r.t as string, ...(r.label ? { label: r.label as string } : {}) }));
    return { conversation, visits, relations };
  }

  getPersonalGraph(): PersonalGraph {
    const concepts = this.db
      .prepare(
        `SELECT c.*, COUNT(v.id) AS visit_count,
           (SELECT v2.summary FROM visits v2 WHERE v2.concept_id = c.id ORDER BY v2.created_at DESC, v2.seq DESC LIMIT 1) AS summary,
           (SELECT COUNT(DISTINCT vs.source_id) FROM visit_sources vs JOIN visits v3 ON v3.id = vs.visit_id
            WHERE v3.concept_id = c.id) AS source_count
         FROM concepts c LEFT JOIN visits v ON v.concept_id = c.id
         GROUP BY c.id
         HAVING COUNT(v.id) > 0 OR EXISTS (SELECT 1 FROM concept_links l WHERE l.kind = 'is_a' AND l.to_concept_id = c.id)`,
      )
      .all()
      .map((r) => ({ ...toConcept(r), summary: (r.summary as string) ?? '', sourceCount: Number(r.source_count ?? 0), conversationIds: [] as string[], superclassId: null as string | null }));
    // Conversations of each concept, the one with most visits first: the canvas colours and filters by them.
    const byId = new Map(concepts.map((c) => [c.id, c]));
    for (const r of this.db
      .prepare(
        `SELECT concept_id, conversation_id FROM visits
         GROUP BY concept_id, conversation_id ORDER BY concept_id, COUNT(*) DESC, MIN(created_at), MIN(rowid)`,
      )
      .all()) {
      byId.get(r.concept_id as string)?.conversationIds.push(r.conversation_id as string);
    }
    for (const r of this.db.prepare(`SELECT from_concept_id AS f, to_concept_id AS t FROM concept_links WHERE kind = 'is_a'`).all()) {
      const c = byId.get(r.f as string);
      if (c) c.superclassId = r.t as string;
    }
    const conversations = this.db
      .prepare(
        `SELECT c.id, c.title FROM conversations c
         WHERE EXISTS (SELECT 1 FROM visits v WHERE v.conversation_id = c.id) ORDER BY c.last_activity_at DESC`,
      )
      .all()
      .map((r) => ({ id: r.id as string, title: r.title as string }));
    // Edges come from drill-downs (parent visit -> child visit) plus explicit concept links.
    const edges = this.db
      .prepare(
        `SELECT source, target, SUM(w) AS weight, MAX(rel) AS rel, MAX(label) AS label FROM (
           SELECT p.concept_id AS source, v.concept_id AS target, COUNT(*) AS w, 0 AS rel, NULL AS label
           FROM visits v JOIN visits p ON p.id = v.parent_visit_id
           WHERE p.concept_id <> v.concept_id
           GROUP BY 1, 2
           UNION ALL
           SELECT from_concept_id, to_concept_id, 1, 1, label FROM concept_links WHERE kind = 'related'
         ) GROUP BY source, target`,
      )
      .all()
      .map((r) => ({ source: r.source as string, target: r.target as string, weight: Number(r.weight), ...(r.rel ? { relation: true } : {}), ...(r.label ? { label: r.label as string } : {}) }));
    return { concepts, edges, conversations };
  }

  addRelation(fromId: string, toId: string, label?: string | null): boolean {
    const text = label?.trim() || null;
    const both = `kind = 'related' AND ((from_concept_id = ?1 AND to_concept_id = ?2) OR (from_concept_id = ?2 AND to_concept_id = ?1))`;
    const exists = this.db.prepare(`SELECT label FROM concept_links WHERE ${both}`).get(fromId, toId);
    if (exists) {
      if (label === undefined || (exists.label ?? null) === text) return false;
      this.db.prepare(`UPDATE concept_links SET label = ?3 WHERE ${both}`).run(fromId, toId, text);
      return true;
    }
    this.db.prepare(`INSERT INTO concept_links (from_concept_id, to_concept_id, kind, label, created_at) VALUES (?, ?, 'related', ?, ?)`).run(fromId, toId, text, now());
    return true;
  }

  removeRelation(aId: string, bId: string): boolean {
    const r = this.db
      .prepare(`DELETE FROM concept_links WHERE kind = 'related' AND ((from_concept_id = ?1 AND to_concept_id = ?2) OR (from_concept_id = ?2 AND to_concept_id = ?1))`)
      .run(aId, bId);
    return Number(r.changes) > 0;
  }

  listRelated(conceptId: string): (ConceptMatch & { label?: string })[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name, l.label FROM concept_links l
         JOIN concepts c ON c.id = CASE WHEN l.from_concept_id = ?1 THEN l.to_concept_id ELSE l.from_concept_id END
         WHERE l.kind = 'related' AND (l.from_concept_id = ?1 OR l.to_concept_id = ?1) ORDER BY c.name`,
      )
      .all(conceptId)
      .map((r) => ({ id: r.id as string, name: r.name as string, ...(r.label ? { label: r.label as string } : {}) }));
  }

  setSuperclass(childId: string, parentId: string | null): void {
    this.db.prepare(`DELETE FROM concept_links WHERE kind = 'is_a' AND from_concept_id = ?`).run(childId);
    if (parentId) this.db.prepare(`INSERT INTO concept_links (from_concept_id, to_concept_id, kind, created_at) VALUES (?, ?, 'is_a', ?)`).run(childId, parentId, now());
  }

  getSuperclass(conceptId: string): ConceptMatch | undefined {
    const r = this.db
      .prepare(`SELECT c.id, c.name FROM concept_links l JOIN concepts c ON c.id = l.to_concept_id WHERE l.kind = 'is_a' AND l.from_concept_id = ?`)
      .get(conceptId);
    return r ? { id: r.id as string, name: r.name as string } : undefined;
  }

  listRootConcepts(): ConceptMatch[] {
    return this.db
      .prepare(
        `SELECT c.id, c.name FROM concepts c
         WHERE EXISTS (SELECT 1 FROM visits v WHERE v.concept_id = c.id AND v.parent_visit_id IS NULL)
           AND NOT EXISTS (SELECT 1 FROM concept_links l WHERE l.kind = 'is_a' AND l.from_concept_id = c.id)
         ORDER BY c.last_seen_at DESC`,
      )
      .all()
      .map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  listSuperclasses(): ConceptMatch[] {
    return this.db
      .prepare(`SELECT c.id, c.name FROM concepts c WHERE EXISTS (SELECT 1 FROM concept_links l WHERE l.kind = 'is_a' AND l.to_concept_id = c.id) ORDER BY c.name`)
      .all()
      .map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  listMembers(superId: string): ConceptMatch[] {
    return this.db
      .prepare(`SELECT c.id, c.name FROM concept_links l JOIN concepts c ON c.id = l.from_concept_id WHERE l.kind = 'is_a' AND l.to_concept_id = ? ORDER BY c.name`)
      .all(superId)
      .map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  recordToolCall(c: ToolCall): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (at, tool, conversation_id, arg_chars, result_chars, duration_ms, ok, error, nodes_created, nodes_changed, hit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.at, c.tool, c.conversationId, c.argChars, c.resultChars, c.durationMs, c.ok ? 1 : 0, c.error, c.nodesCreated, c.nodesChanged, c.hit === null ? null : c.hit ? 1 : 0);
  }

  listToolCalls(since?: string): ToolCall[] {
    const rows = since
      ? this.db.prepare('SELECT * FROM tool_calls WHERE at >= ? ORDER BY id').all(since)
      : this.db.prepare('SELECT * FROM tool_calls ORDER BY id').all();
    return rows.map((r) => ({
      at: r.at as string,
      tool: r.tool as string,
      conversationId: (r.conversation_id as string | null) ?? null,
      argChars: Number(r.arg_chars),
      resultChars: Number(r.result_chars),
      durationMs: Number(r.duration_ms),
      ok: r.ok === 1,
      error: (r.error as string | null) ?? null,
      nodesCreated: Number(r.nodes_created),
      nodesChanged: Number(r.nodes_changed),
      hit: r.hit === null ? null : r.hit === 1,
    }));
  }

  counters(): { visits: number; revisions: number } {
    const n = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    return { visits: n('SELECT COUNT(*) AS n FROM visits'), revisions: n('SELECT COUNT(*) AS n FROM revisions') };
  }

  graphSnapshot(): GraphSnapshot {
    const strings = (sql: string) => this.db.prepare(sql).all().map((r) => r.t as string);
    return {
      conversations: this.db.prepare('SELECT id, started_at FROM conversations').all().map((r) => ({ id: r.id as string, at: r.started_at as string })),
      concepts: this.db
        .prepare(
          `SELECT c.id, c.name, c.created_at,
             EXISTS (SELECT 1 FROM concept_links l WHERE l.kind = 'is_a' AND l.from_concept_id = c.id) AS has_super
           FROM concepts c`,
        )
        .all()
        .map((r) => ({ id: r.id as string, name: r.name as string, at: r.created_at as string, hasSuperclass: r.has_super === 1 })),
      visits: this.db
        .prepare(
          `SELECT v.id, v.conversation_id, v.concept_id, v.parent_visit_id, v.created_at,
             (v.detail IS NOT NULL AND trim(v.detail) <> '') AS has_detail,
             (SELECT COUNT(*) FROM visit_sources vs WHERE vs.visit_id = v.id) AS sources
           FROM visits v`,
        )
        .all()
        .map((r) => ({
          id: r.id as string,
          conversationId: r.conversation_id as string,
          conceptId: r.concept_id as string,
          parentVisitId: (r.parent_visit_id as string | null) ?? null,
          at: r.created_at as string,
          hasDetail: r.has_detail === 1,
          sourceCount: Number(r.sources),
        })),
      relationTimes: strings(`SELECT COALESCE(created_at, '') AS t FROM concept_links`),
    };
  }

  addRevision(r: Omit<Revision, 'createdAt'>): void {
    this.db
      .prepare('INSERT INTO revisions (target_kind, target_id, field, old_value, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(r.targetKind, r.targetId, r.field, r.oldValue, now());
  }

  listRevisions(targetKind: Revision['targetKind'], targetId: string): Revision[] {
    return this.db
      .prepare('SELECT * FROM revisions WHERE target_kind = ? AND target_id = ? ORDER BY id')
      .all(targetKind, targetId)
      .map((r) => ({
        targetKind: r.target_kind as Revision['targetKind'],
        targetId: r.target_id as string,
        field: r.field as string,
        oldValue: (r.old_value as string | null) ?? null,
        createdAt: r.created_at as string,
      }));
  }

  layoutEntries(): LayoutEntry[] {
    return this.db
      .prepare('SELECT kind, id, x, y FROM canvas_layout')
      .all()
      .map((r) => ({ kind: r.kind as LayoutEntry['kind'], id: r.id as string, x: r.x as number, y: r.y as number }));
  }

  setLayout(entries: Parameters<Repository['setLayout']>[0]): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO canvas_layout (kind, id, x, y) VALUES (?, ?, ?, ?)');
    const drop = this.db.prepare('DELETE FROM canvas_layout WHERE kind = ? AND id = ?');
    this.db.exec('BEGIN');
    try {
      for (const e of entries) {
        if (typeof e.x === 'number' && typeof e.y === 'number') put.run(e.kind, e.id, e.x, e.y);
        else drop.run(e.kind, e.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getSetting(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value as string | undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
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
