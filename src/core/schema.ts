export const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  client TEXT,
  current_visit_id TEXT,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  parent_visit_id TEXT REFERENCES visits(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  excerpt TEXT,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_conversation ON visits(conversation_id, seq);
CREATE INDEX IF NOT EXISTS visits_concept ON visits(concept_id);

CREATE TABLE IF NOT EXISTS concept_links (
  from_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  to_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  PRIMARY KEY (from_concept_id, to_concept_id, kind)
);

CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
  concept_id UNINDEXED, name, tokenize = 'trigram remove_diacritics 1'
);
`;
