export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(label)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  imported_at TEXT NOT NULL,
  occurred_at TEXT,
  occurred_at_precision TEXT NOT NULL,
  occurred_at_trust TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  current_revision_id TEXT,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sources_external_active
  ON sources(external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS source_revisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, version)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  revision_id TEXT NOT NULL REFERENCES source_revisions(id),
  external_id TEXT,
  original_label TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  seq INTEGER NOT NULL,
  occurred_at TEXT,
  start_cp INTEGER NOT NULL,
  end_cp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_source_rev ON messages(source_id, revision_id, seq);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  review_state TEXT NOT NULL,
  content_state TEXT NOT NULL,
  applicable_at TEXT,
  created_via TEXT NOT NULL,
  model_name TEXT,
  prompt_template_version TEXT,
  is_user_note INTEGER NOT NULL DEFAULT 0,
  invalidated INTEGER NOT NULL DEFAULT 0,
  invalidated_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  source_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  start_cp INTEGER NOT NULL,
  end_cp INTEGER NOT NULL,
  quote TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_revisions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replacements (
  id TEXT PRIMARY KEY,
  old_card_id TEXT NOT NULL,
  new_card_id TEXT NOT NULL,
  confirmed INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  source_versions_json TEXT NOT NULL,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  topic_id TEXT,
  question TEXT NOT NULL,
  body TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  variant TEXT NOT NULL,
  body TEXT NOT NULL,
  included_card_ids TEXT NOT NULL,
  excluded_json TEXT,
  created_at TEXT NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  anon_ids TEXT
);
`;

export const SCHEMA_VERSION = 1;
