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

-- Previous values of every manual or model edit (D16): history for a future versioning UI.
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_target ON revisions(target_kind, target_id);

-- Pages and documents the model cited (kc_track sources), once per normalized URL, linked to the nodes they support.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visit_sources (
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (visit_id, source_id)
);
CREATE INDEX IF NOT EXISTS visit_sources_source ON visit_sources(source_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
  concept_id UNINDEXED, name, tokenize = 'trigram remove_diacritics 1'
);
`;
