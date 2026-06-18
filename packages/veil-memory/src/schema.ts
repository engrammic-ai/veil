/**
 * SQLite schema for event-sourced memory storage.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
-- Events table: append-only, never updated
CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,

  -- Event metadata
  event_type TEXT NOT NULL CHECK(event_type IN ('assert', 'retract', 'reinforce')),
  agent_id TEXT NOT NULL,

  -- Content
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,

  -- Classification
  memory_type TEXT NOT NULL CHECK(memory_type IN ('episodic', 'factual', 'procedural')),
  subject TEXT,
  subject_hash TEXT,

  -- Version vector (JSON)
  version_vector TEXT NOT NULL,

  -- Confidence (factual only)
  confidence REAL DEFAULT 0.8 CHECK(confidence BETWEEN 0 AND 1),
  evidence_count INTEGER DEFAULT 1,

  -- Bi-temporal
  valid_from REAL NOT NULL,
  recorded_at REAL NOT NULL,

  -- FSRS initial values
  difficulty REAL DEFAULT 0.5 CHECK(difficulty BETWEEN 0.1 AND 0.9),
  stability REAL DEFAULT 1.0 CHECK(stability >= 0.001),

  -- Embedding model version
  embedding_model TEXT DEFAULT 'nomic-embed-text-v1.5',

  -- Source provenance
  source_tier TEXT CHECK(source_tier IN (
    'authoritative', 'validated', 'observed', 'inferred'
  )) DEFAULT 'observed',

  -- Tags (JSON array)
  tags TEXT DEFAULT '[]'
);

-- Indexes on events
CREATE INDEX IF NOT EXISTS idx_events_namespace ON memory_events(namespace);
CREATE INDEX IF NOT EXISTS idx_events_subject ON memory_events(subject_hash)
  WHERE memory_type IN ('factual', 'procedural');
CREATE INDEX IF NOT EXISTS idx_events_recorded ON memory_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON memory_events(memory_type);
CREATE INDEX IF NOT EXISTS idx_events_content_hash ON memory_events(content_hash);
CREATE INDEX IF NOT EXISTS idx_events_valid_from ON memory_events(valid_from);

-- Vector embeddings (sqlite-vec uses rowid internally)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  embedding FLOAT[768]
);

-- Link vectors to events
CREATE TABLE IF NOT EXISTS memory_vector_map (
  rowid INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (event_id) REFERENCES memory_events(event_id)
);

-- Current state projection (derived, rebuildable)
CREATE TABLE IF NOT EXISTS current_beliefs (
  event_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  subject TEXT,
  subject_hash TEXT,
  confidence REAL,
  valid_from REAL NOT NULL,
  recorded_at REAL NOT NULL,

  -- FSRS live values
  difficulty REAL NOT NULL,
  stability REAL NOT NULL,
  retrievability REAL NOT NULL,
  last_recall REAL,
  recall_count INTEGER DEFAULT 0,

  -- Conflict tracking
  has_conflicts INTEGER DEFAULT 0,
  conflict_event_ids TEXT,

  FOREIGN KEY (event_id) REFERENCES memory_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_beliefs_namespace ON current_beliefs(namespace);
CREATE INDEX IF NOT EXISTS idx_beliefs_subject ON current_beliefs(subject_hash);
CREATE INDEX IF NOT EXISTS idx_beliefs_retrievability ON current_beliefs(retrievability);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at REAL NOT NULL
);

-- FTS5 full-text search (baseline, always available)
-- Note: No UPDATE trigger needed - memory_events is append-only by design
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  event_id UNINDEXED,
  content,
  subject,
  tags,
  content='memory_events',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_events BEGIN
  INSERT INTO memory_fts(rowid, event_id, content, subject, tags)
  VALUES (NEW.rowid, NEW.event_id, NEW.content, NEW.subject, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_events BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, event_id, content, subject, tags)
  VALUES ('delete', OLD.rowid, OLD.event_id, OLD.content, OLD.subject, OLD.tags);
END;
`;

export function initSchema(db: Database.Database): void {
	db.exec(SCHEMA_SQL);

	const currentVersion = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
		| { version: number | null }
		| undefined;

	if (!currentVersion || currentVersion.version === null) {
		db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, Date.now());
	}
}

export function getSchemaVersion(db: Database.Database): number {
	const result = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as
		| { version: number | null }
		| undefined;
	return result?.version ?? 0;
}

export function needsMigration(db: Database.Database): boolean {
	return getSchemaVersion(db) < SCHEMA_VERSION;
}
