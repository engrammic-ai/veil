/**
 * SQLite warm cache for context items.
 * Fast local storage for recent/frequent items.
 */

import { createHash } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { CaptureLink } from "./capture-document.ts";
import { defaultFSRS } from "./fsrs.ts";
import Database from "./sqlite.ts";
import type { ContextItem, Trigger } from "./types.ts";
import { CoAccessTracker } from "./worldview/co-access.ts";

export interface HydrationEvent {
	sessionId: string;
	itemId: string;
	triggerIds: string[];
	userMessage: string;
	hydratedAt: number;
	latencyMs: number;
}

export class ContextCache {
	private db: BetterSqlite3.Database;
	private dedupeIndex: Map<string, string> = new Map(); // dedupeKey -> itemId

	// Prepared statements (initialised once in constructor, reused on every call)
	private stmtPut: BetterSqlite3.Statement;
	private stmtGet: BetterSqlite3.Statement;
	private stmtGetByHash: BetterSqlite3.Statement;
	private stmtTouch: BetterSqlite3.Statement;
	private stmtTouchWithFSRS: BetterSqlite3.Statement;
	private stmtUpdateCognitiveWeight: BetterSqlite3.Statement;
	private stmtDelete: BetterSqlite3.Statement;
	private stmtGetAll: BetterSqlite3.Statement;
	private stmtGetStale: BetterSqlite3.Statement;
	private stmtApplyDecay: BetterSqlite3.Statement;
	private stmtPruneByDecaySelect: BetterSqlite3.Statement;
	private stmtPruneByDecayDelete: BetterSqlite3.Statement;
	private stmtGetAllByRecency: BetterSqlite3.Statement;
	private stmtGetTypeCounts: BetterSqlite3.Statement;
	private stmtMarkEvicting: BetterSqlite3.Statement;
	private stmtUnmarkEvicting: BetterSqlite3.Statement;
	private stmtDeleteEvicting: BetterSqlite3.Statement;
	private stmtRecoverEvicting: BetterSqlite3.Statement;

	// Hydration event statements
	private stmtLogHydration: BetterSqlite3.Statement;
	private stmtGetRecentHydrations: BetterSqlite3.Statement;
	private stmtGetHydrationStats: BetterSqlite3.Statement;

	// Custom trigger statements
	private stmtPersistTrigger: BetterSqlite3.Statement;
	private stmtLoadCustomTriggers: BetterSqlite3.Statement;
	private stmtDeleteTrigger: BetterSqlite3.Statement;

	// Episode link statements
	private stmtLinkEpisodes: BetterSqlite3.Statement;
	private stmtGetRelatedEpisodes: BetterSqlite3.Statement;

	// Memory link statements
	private stmtAddLinks: BetterSqlite3.Statement;
	private stmtGetLinks: BetterSqlite3.Statement;
	private stmtGetBacklinks: BetterSqlite3.Statement;

	// Eviction ledger statements
	private stmtLogEviction: BetterSqlite3.Statement;
	private stmtFindRecentEviction: BetterSqlite3.Statement;
	private stmtClearEvictionForHash: BetterSqlite3.Statement;
	private stmtPruneEvictionLog: BetterSqlite3.Statement;

	// Search statement
	private stmtSearch: BetterSqlite3.Statement;

	// Feedback tracking statements
	private stmtIncrementUsedCount: BetterSqlite3.Statement;
	private stmtIncrementIgnoredCount: BetterSqlite3.Statement;
	private stmtGetArchiveCandidates: BetterSqlite3.Statement;

	// Co-access tracker
	readonly coAccess: CoAccessTracker;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.init();

		this.stmtPut = this.db.prepare(`
			INSERT OR REPLACE INTO items (
				id, content, content_hash,
				created_at, last_access, access_count,
				decay_score, cognitive_weight,
				stability, difficulty,
				type, tags, pinned,
				kg_pointer, depends_on,
				valid_from, valid_until,
				source, source_tool_call_id,
				resource_mtime, resource_hash
			) VALUES (
				?, ?, ?,
				?, ?, ?,
				?, ?,
				?, ?,
				?, ?, ?,
				?, ?,
				?, ?,
				?, ?,
				?, ?
			)
		`);

		this.stmtGet = this.db.prepare("SELECT * FROM items WHERE id = ?");

		this.stmtGetByHash = this.db.prepare("SELECT * FROM items WHERE content_hash = ?");

		this.stmtTouch = this.db.prepare(
			"UPDATE items SET last_access = ?, access_count = access_count + 1 WHERE id = ?",
		);

		this.stmtTouchWithFSRS = this.db.prepare(
			"UPDATE items SET last_access = ?, access_count = access_count + 1, stability = ? WHERE id = ?",
		);

		this.stmtUpdateCognitiveWeight = this.db.prepare(`
			UPDATE items
			SET cognitive_weight = MAX(-1, MIN(1, cognitive_weight * 0.95 + ?))
			WHERE id = ?
		`);

		this.stmtDelete = this.db.prepare("DELETE FROM items WHERE id = ?");

		this.stmtGetAll = this.db.prepare("SELECT * FROM items");

		this.stmtGetAllByRecency = this.db.prepare("SELECT * FROM items ORDER BY last_access DESC LIMIT ?");

		this.stmtGetStale = this.db.prepare("SELECT * FROM items WHERE last_access < ? AND access_count <= ?");

		this.stmtApplyDecay = this.db.prepare(
			"UPDATE items SET decay_score = decay_score + (1 - ?) WHERE decay_score < 1",
		);

		this.stmtPruneByDecaySelect = this.db.prepare("SELECT id FROM items WHERE decay_score >= ?");

		this.stmtPruneByDecayDelete = this.db.prepare("DELETE FROM items WHERE decay_score >= ?");

		this.stmtGetTypeCounts = this.db.prepare("SELECT type, COUNT(*) AS count FROM items GROUP BY type");

		this.stmtMarkEvicting = this.db.prepare("UPDATE items SET evicting = 1 WHERE id = ?");

		this.stmtUnmarkEvicting = this.db.prepare("UPDATE items SET evicting = 0 WHERE id = ?");

		this.stmtDeleteEvicting = this.db.prepare("DELETE FROM items WHERE id = ? AND evicting = 1");

		this.stmtRecoverEvicting = this.db.prepare("SELECT * FROM items WHERE evicting = 1");

		this.stmtLogHydration = this.db.prepare(`
			INSERT OR IGNORE INTO hydration_events
			(session_id, item_id, trigger_ids, user_message, hydrated_at, latency_ms)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmtGetRecentHydrations = this.db.prepare(`
			SELECT * FROM hydration_events
			ORDER BY hydrated_at DESC LIMIT ?
		`);

		this.stmtGetHydrationStats = this.db.prepare(`
			SELECT COUNT(*) as count, AVG(latency_ms) as avg_latency
			FROM hydration_events WHERE item_id = ?
		`);

		this.stmtPersistTrigger = this.db.prepare(`
			INSERT INTO custom_triggers
			(id, pattern, pattern_flags, negative_pattern, negative_pattern_flags,
			 type, action_tags, action_type,
			 priority, enabled, learned, confidence, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
			  pattern = excluded.pattern,
			  pattern_flags = excluded.pattern_flags,
			  negative_pattern = excluded.negative_pattern,
			  negative_pattern_flags = excluded.negative_pattern_flags,
			  type = excluded.type,
			  action_tags = excluded.action_tags,
			  action_type = excluded.action_type,
			  priority = excluded.priority,
			  enabled = excluded.enabled,
			  learned = excluded.learned,
			  confidence = excluded.confidence,
			  updated_at = excluded.updated_at
		`);

		this.stmtLoadCustomTriggers = this.db.prepare(`
			SELECT * FROM custom_triggers WHERE enabled = 1
		`);

		this.stmtDeleteTrigger = this.db.prepare(`
			DELETE FROM custom_triggers WHERE id = ?
		`);

		this.stmtLinkEpisodes = this.db.prepare(`
			INSERT OR IGNORE INTO episode_links (source_id, target_id, relation, created_at)
			VALUES (?, ?, ?, ?)
		`);

		this.stmtGetRelatedEpisodes = this.db.prepare(`
			SELECT target_id AS linked_id, relation FROM episode_links WHERE source_id = ?
			UNION
			SELECT source_id AS linked_id, relation FROM episode_links WHERE target_id = ?
		`);

		this.stmtAddLinks = this.db.prepare(`
			INSERT OR IGNORE INTO memory_links (source_id, target, rel, label)
			VALUES (?, ?, ?, ?)
		`);

		this.stmtGetLinks = this.db.prepare(`
			SELECT target, rel, label FROM memory_links WHERE source_id = ?
		`);

		this.stmtGetBacklinks = this.db.prepare(`
			SELECT source_id, rel, label FROM memory_links WHERE target = ?
		`);

		this.stmtLogEviction = this.db.prepare(
			"INSERT INTO eviction_log (item_id, content_hash, evicted_at, evicted_turn) VALUES (?, ?, ?, ?)",
		);

		this.stmtFindRecentEviction = this.db.prepare(`
			SELECT item_id, evicted_at, evicted_turn FROM eviction_log
			WHERE content_hash = ? AND evicted_at >= ?
			ORDER BY evicted_at DESC LIMIT 1
		`);

		this.stmtClearEvictionForHash = this.db.prepare("DELETE FROM eviction_log WHERE content_hash = ?");

		this.stmtPruneEvictionLog = this.db.prepare("DELETE FROM eviction_log WHERE evicted_at < ?");

		this.stmtSearch = this.db.prepare(
			"SELECT * FROM items WHERE content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' ORDER BY last_access DESC LIMIT ?",
		);

		this.stmtIncrementUsedCount = this.db.prepare("UPDATE items SET used_count = used_count + 1 WHERE id = ?");

		this.stmtIncrementIgnoredCount = this.db.prepare(
			"UPDATE items SET ignored_count = ignored_count + 1 WHERE id = ?",
		);

		this.stmtGetArchiveCandidates = this.db.prepare(
			"SELECT * FROM items WHERE ignored_count > used_count * 3 AND ignored_count > 0",
		);

		this.coAccess = new CoAccessTracker(this.db);
	}

	/**
	 * Get the underlying database connection.
	 * Use sparingly - prefer using cache methods directly.
	 */
	getDb(): BetterSqlite3.Database {
		return this.db;
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS items (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL,

				created_at REAL NOT NULL,
				last_access REAL NOT NULL,
				access_count INTEGER DEFAULT 1,

				decay_score REAL DEFAULT 0.0,
				cognitive_weight REAL DEFAULT 0.0,

				type TEXT CHECK(type IN ('episodic', 'procedural', 'fact', 'decision', 'intent')) NOT NULL,
				tags TEXT NOT NULL,
				pinned INTEGER DEFAULT 0,

				kg_pointer TEXT,
				depends_on TEXT,

				valid_from REAL,
				valid_until REAL,

				source TEXT CHECK(source IN ('auto', 'explicit')) DEFAULT 'auto',
				source_tool_call_id TEXT,

				evicting INTEGER DEFAULT 0
			);

			CREATE INDEX IF NOT EXISTS idx_last_access ON items(last_access);
			CREATE INDEX IF NOT EXISTS idx_decay_score ON items(decay_score);
			CREATE INDEX IF NOT EXISTS idx_type ON items(type);
			CREATE INDEX IF NOT EXISTS idx_tags ON items(tags);
			CREATE INDEX IF NOT EXISTS idx_evicting ON items(evicting);
		`);

		// Migration: add source_tool_call_id column if it doesn't exist
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN source_tool_call_id TEXT");
		} catch {
			// Column already exists
		}

		// Migration: add FSRS columns
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN stability REAL DEFAULT 0.5");
		} catch {
			// Column already exists
		}
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN difficulty REAL DEFAULT 0.5");
		} catch {
			// Column already exists
		}

		// Migration: add feedback tracking columns
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN used_count INTEGER DEFAULT 0");
		} catch {
			// Column already exists
		}
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN ignored_count INTEGER DEFAULT 0");
		} catch {
			// Column already exists
		}

		// Index must be created after migration adds the column
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_tool_call_id ON items(source_tool_call_id)");
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_stability ON items(stability)");

		// Hydration events table for Phase 6 learning
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS hydration_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				item_id TEXT NOT NULL,
				trigger_ids TEXT NOT NULL,
				user_message TEXT NOT NULL,
				hydrated_at REAL NOT NULL,
				latency_ms REAL,
				UNIQUE(session_id, item_id, hydrated_at)
			);

			CREATE INDEX IF NOT EXISTS idx_hydration_item ON hydration_events(item_id);
			CREATE INDEX IF NOT EXISTS idx_hydration_session ON hydration_events(session_id);
		`);

		// Custom triggers table for Phase 6 learning
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS custom_triggers (
				id TEXT PRIMARY KEY,
				pattern TEXT NOT NULL,
				pattern_flags TEXT NOT NULL DEFAULT '',
				negative_pattern TEXT,
				negative_pattern_flags TEXT,
				type TEXT NOT NULL DEFAULT 'keyword',
				action_tags TEXT,
				action_type TEXT,
				priority INTEGER DEFAULT 10,
				enabled INTEGER DEFAULT 1,
				learned INTEGER DEFAULT 0,
				confidence REAL,
				created_at REAL NOT NULL,
				updated_at REAL NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON custom_triggers(enabled);
			CREATE INDEX IF NOT EXISTS idx_triggers_type ON custom_triggers(type);
		`);

		// Migration: add pattern_flags columns if they don't exist
		try {
			this.db.exec("ALTER TABLE custom_triggers ADD COLUMN pattern_flags TEXT NOT NULL DEFAULT ''");
		} catch {
			// Column already exists
		}
		try {
			this.db.exec("ALTER TABLE custom_triggers ADD COLUMN negative_pattern_flags TEXT");
		} catch {
			// Column already exists
		}

		// Episode links table for Part 5 schema
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS episode_links (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_id TEXT NOT NULL,
				target_id TEXT NOT NULL,
				relation TEXT NOT NULL,
				created_at REAL NOT NULL,
				UNIQUE(source_id, target_id, relation)
			);

			CREATE INDEX IF NOT EXISTS idx_episode_source ON episode_links(source_id);
			CREATE INDEX IF NOT EXISTS idx_episode_target ON episode_links(target_id);
		`);

		// Eviction ledger for re-request (miss) detection — drives self-tuning
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS eviction_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				item_id TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				evicted_at REAL NOT NULL,
				evicted_turn INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_eviction_hash ON eviction_log(content_hash);
			CREATE INDEX IF NOT EXISTS idx_eviction_item ON eviction_log(item_id);
		`);

		// Co-access table for behavioral worldview — feeds anticipatory loading
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS co_access (
				item_a TEXT NOT NULL,
				item_b TEXT NOT NULL,
				count INTEGER NOT NULL DEFAULT 1,
				last_turn INTEGER NOT NULL,
				PRIMARY KEY (item_a, item_b)
			);
			CREATE INDEX IF NOT EXISTS idx_co_access_a ON co_access(item_a);
			CREATE INDEX IF NOT EXISTS idx_co_access_b ON co_access(item_b);
		`);

		// Symbol graph for structural worldview — feeds PageRank ranking
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS symbol_graph (
				file TEXT NOT NULL,
				symbol TEXT NOT NULL,
				kind TEXT NOT NULL,
				target_file TEXT,
				target_symbol TEXT,
				line INTEGER,
				PRIMARY KEY (file, symbol, kind, line)
			);
			CREATE INDEX IF NOT EXISTS idx_symbol_graph_file ON symbol_graph(file);
			CREATE INDEX IF NOT EXISTS idx_symbol_graph_symbol ON symbol_graph(symbol);
		`);

		// File mtime tracker — drives mtime-based cache invalidation
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS file_mtime (
				file TEXT PRIMARY KEY,
				mtime INTEGER NOT NULL,
				symbols_updated_at INTEGER NOT NULL
			);
		`);

		// Structural rank — PageRank scores for files in the symbol graph
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS structural_rank (
				file TEXT PRIMARY KEY,
				pagerank REAL NOT NULL,
				task_bias REAL NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);
		`);

		// Memory links for graph traversal (CaptureDocument links)
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memory_links (
				source_id TEXT NOT NULL,
				target TEXT NOT NULL,
				rel TEXT NOT NULL,
				label TEXT,
				PRIMARY KEY (source_id, target, rel),
				FOREIGN KEY (source_id) REFERENCES items(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
			CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target);
		`);

		// Phase D: Attempts table for failure-memory
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				goal_id TEXT NOT NULL,
				iteration INTEGER NOT NULL,

				action TEXT NOT NULL,
				target TEXT,
				rationale TEXT,

				outcome TEXT NOT NULL CHECK(outcome IN ('fail', 'pass', 'partial', 'uncertain')),
				evidence TEXT,
				error_pattern TEXT,

				created_at REAL NOT NULL,
				turn INTEGER NOT NULL,

				goal_open INTEGER DEFAULT 1,
				pinned INTEGER DEFAULT 0
			);

			CREATE INDEX IF NOT EXISTS idx_attempts_goal ON attempts(goal_id);
			CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
			CREATE INDEX IF NOT EXISTS idx_attempts_outcome ON attempts(outcome);
			CREATE INDEX IF NOT EXISTS idx_attempts_open ON attempts(goal_open);
		`);

		// Migration: add staleness tracking columns
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN resource_mtime REAL");
		} catch {
			// Column already exists
		}
		try {
			this.db.exec("ALTER TABLE items ADD COLUMN resource_hash TEXT");
		} catch {
			// Column already exists
		}
	}

	put(item: ContextItem): void {
		this.stmtPut.run(
			item.id,
			item.content,
			item.contentHash,
			item.createdAt,
			item.lastAccess,
			item.accessCount,
			item.decayScore,
			item.cognitiveWeight,
			item.stability,
			item.difficulty,
			item.type,
			JSON.stringify(item.tags),
			item.pinned ? 1 : 0,
			item.kgPointer ?? null,
			item.dependsOn ? JSON.stringify(item.dependsOn) : null,
			item.validFrom ?? null,
			item.validUntil ?? null,
			item.source,
			item.sourceToolCallId ?? null,
			item.resourceMtime ?? null,
			item.resourceHash ?? null,
		);
	}

	get(id: string): ContextItem | null {
		const row = this.stmtGet.get(id) as any;
		if (!row) return null;
		return this.rowToItem(row);
	}

	getAll(): ContextItem[] {
		const rows = this.stmtGetAll.all() as any[];
		return rows.map((row) => this.rowToItem(row));
	}

	/**
	 * Returns a map of type → count using a single aggregated SQL query.
	 * Much cheaper than getAll() when only counts are needed.
	 */
	getTypeCounts(): Record<string, number> {
		const rows = this.stmtGetTypeCounts.all() as Array<{ type: string; count: number }>;
		const result: Record<string, number> = {};
		for (const row of rows) {
			result[row.type] = row.count;
		}
		return result;
	}

	getByTags(tags: string[], limit: number = 100): ContextItem[] {
		// With no tags, return all items up to limit ordered by recency
		if (tags.length === 0) {
			const rows = this.stmtGetAllByRecency.all(limit) as any[];
			return rows.map((row) => this.rowToItem(row));
		}

		// Escape LIKE special characters (%, _) in each tag to prevent wildcard injection.
		// SQLite ESCAPE clause uses '\' as the escape character.
		const escapedTags = tags.map((t) => t.replace(/[%_\\]/g, "\\$&"));

		// Simple tag matching — items containing any of the tags
		const placeholders = escapedTags.map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ");
		const params = escapedTags.map((t) => `%"${t}"%`);

		const rows = this.db
			.prepare(`SELECT * FROM items WHERE ${placeholders} ORDER BY last_access DESC LIMIT ?`)
			.all(...params, limit) as any[];

		return rows.map((row) => this.rowToItem(row));
	}

	searchItems(query: string, limit: number = 10): ContextItem[] {
		// Escape LIKE special characters (%, _) to prevent wildcard injection.
		// SQLite ESCAPE clause uses '\' as the escape character.
		const escaped = query.replace(/[%_\\]/g, "\\$&");
		const pattern = `%${escaped}%`;
		const rows = this.stmtSearch.all(pattern, pattern, limit) as any[];
		return rows.map((row) => this.rowToItem(row));
	}

	getByHash(hash: string): ContextItem | null {
		const row = this.stmtGetByHash.get(hash) as any;
		if (!row) return null;
		return this.rowToItem(row);
	}

	getByDedupeKey(key: string): ContextItem | undefined {
		const id = this.dedupeIndex.get(key);
		return id ? (this.get(id) ?? undefined) : undefined;
	}

	registerDedupeKey(key: string, itemId: string): void {
		this.dedupeIndex.set(key, itemId);
	}

	removeDedupeKey(key: string): void {
		this.dedupeIndex.delete(key);
	}

	updateByDedupeKey(dedupeKey: string, newContent: string): boolean {
		const id = this.dedupeIndex.get(dedupeKey);
		if (!id) return false;
		const hash = createHash("sha256").update(newContent).digest("hex");
		this.db.prepare("UPDATE items SET content = ?, content_hash = ? WHERE id = ?").run(newContent, hash, id);
		return true;
	}

	delete(id: string): void {
		this.stmtDelete.run(id);
	}

	touch(id: string): void {
		const now = Date.now();
		this.stmtTouch.run(now, id);
	}

	/**
	 * Touch with FSRS stability update.
	 * Computes new stability based on how long since last access and current retrievability.
	 */
	touchWithFSRS(item: ContextItem): void {
		const now = Date.now();
		const daysSinceAccess = defaultFSRS.daysSince(item.lastAccess, now);
		const retrievability = defaultFSRS.computeRetrievability(item.stability, daysSinceAccess);
		const newStability = defaultFSRS.updateStability(item.stability, item.difficulty, retrievability, item.type);
		this.stmtTouchWithFSRS.run(now, newStability, item.id);
	}

	updateCognitiveWeight(id: string, delta: number): void {
		this.stmtUpdateCognitiveWeight.run(delta, id);
	}

	/**
	 * Batch update cognitive weight for multiple items in a single SQL statement.
	 * Significantly faster than N individual UPDATE calls when the loaded set is large.
	 */
	updateCognitiveWeightBatch(ids: string[], delta: number): void {
		if (ids.length === 0) return;
		if (ids.length === 1) {
			this.stmtUpdateCognitiveWeight.run(delta, ids[0]);
			return;
		}
		const placeholders = ids.map(() => "?").join(", ");
		this.db
			.prepare(
				`UPDATE items
				SET cognitive_weight = MAX(-1, MIN(1, cognitive_weight * 0.95 + ?))
				WHERE id IN (${placeholders})`,
			)
			.run(delta, ...ids);
	}

	applyDecay(decayFactor: number = 0.95): void {
		this.stmtApplyDecay.run(decayFactor);
	}

	pruneByDecay(threshold: number = 0.9): string[] {
		const rows = this.stmtPruneByDecaySelect.all(threshold) as any[];
		const ids = rows.map((r) => r.id);

		if (ids.length > 0) {
			this.stmtPruneByDecayDelete.run(threshold);
		}

		return ids;
	}

	getStale(maxAgeMs: number, maxAccessCount: number = 1): ContextItem[] {
		const cutoff = Date.now() - maxAgeMs;
		const rows = this.stmtGetStale.all(cutoff, maxAccessCount) as any[];
		return rows.map((row) => this.rowToItem(row));
	}

	markEvicting(id: string): void {
		this.stmtMarkEvicting.run(id);
	}

	unmarkEvicting(id: string): void {
		this.stmtUnmarkEvicting.run(id);
	}

	deleteEvicting(id: string): void {
		this.stmtDeleteEvicting.run(id);
	}

	recoverEvicting(): ContextItem[] {
		const rows = this.stmtRecoverEvicting.all() as any[];
		return rows.map((row) => this.rowToItem(row));
	}

	logEviction(itemId: string, contentHash: string, turn: number): void {
		this.stmtLogEviction.run(itemId, contentHash, Date.now(), turn);
	}

	findRecentEviction(
		contentHash: string,
		withinMs: number,
	): { itemId: string; evictedAt: number; evictedTurn: number } | null {
		const cutoff = Date.now() - withinMs;
		const row = this.stmtFindRecentEviction.get(contentHash, cutoff) as
			| { item_id: string; evicted_at: number; evicted_turn: number }
			| undefined;
		if (!row) return null;
		return { itemId: row.item_id, evictedAt: row.evicted_at, evictedTurn: row.evicted_turn };
	}

	clearEvictionForHash(contentHash: string): void {
		this.stmtClearEvictionForHash.run(contentHash);
	}

	pruneEvictionLog(olderThanMs: number): number {
		const cutoff = Date.now() - olderThanMs;
		const result = this.stmtPruneEvictionLog.run(cutoff);
		return result.changes;
	}

	logHydration(event: HydrationEvent): void {
		this.stmtLogHydration.run(
			event.sessionId,
			event.itemId,
			JSON.stringify(event.triggerIds),
			event.userMessage,
			event.hydratedAt,
			event.latencyMs,
		);
	}

	getRecentHydrations(limit: number): HydrationEvent[] {
		const rows = this.stmtGetRecentHydrations.all(limit) as any[];
		return rows.map((row) => ({
			sessionId: row.session_id,
			itemId: row.item_id,
			triggerIds: JSON.parse(row.trigger_ids),
			userMessage: row.user_message,
			hydratedAt: row.hydrated_at,
			latencyMs: row.latency_ms,
		}));
	}

	getHydrationStats(itemId: string): { count: number; avgLatency: number } {
		const row = this.stmtGetHydrationStats.get(itemId) as any;
		if (!row) return { count: 0, avgLatency: 0 };
		return { count: row.count, avgLatency: row.avg_latency ?? 0 };
	}

	persistTrigger(trigger: Trigger): void {
		const now = Date.now();
		this.stmtPersistTrigger.run(
			trigger.id,
			trigger.pattern.source,
			trigger.pattern.flags,
			trigger.negative?.source ?? null,
			trigger.negative?.flags ?? null,
			trigger.type,
			JSON.stringify(trigger.action.tags ?? []),
			trigger.action.type ?? null,
			trigger.priority,
			trigger.enabled ? 1 : 0,
			trigger.learned ? 1 : 0,
			trigger.confidence ?? null,
			now,
			now,
		);
	}

	loadCustomTriggers(): Trigger[] {
		const rows = this.stmtLoadCustomTriggers.all() as any[];
		return rows.map((row) => ({
			id: row.id,
			pattern: new RegExp(row.pattern, row.pattern_flags || ""),
			negative: row.negative_pattern
				? new RegExp(row.negative_pattern, row.negative_pattern_flags || "")
				: undefined,
			type: row.type as "keyword" | "file" | "command",
			action: {
				tags: row.action_tags ? JSON.parse(row.action_tags) : undefined,
				type: row.action_type ?? undefined,
			},
			priority: row.priority,
			enabled: true,
			learned: row.learned === 1,
			confidence: row.confidence ?? undefined,
		}));
	}

	deleteTrigger(id: string): void {
		this.stmtDeleteTrigger.run(id);
	}

	linkEpisodes(sourceId: string, targetId: string, relation: "continues" | "relates" | "supersedes"): void {
		this.stmtLinkEpisodes.run(sourceId, targetId, relation, Date.now());
	}

	getRelatedEpisodes(itemId: string): Array<{ item: ContextItem; relation: string }> {
		const rows = this.stmtGetRelatedEpisodes.all(itemId, itemId) as Array<{
			linked_id: string;
			relation: string;
		}>;

		return rows
			.map((row) => {
				const item = this.get(row.linked_id);
				return item ? { item, relation: row.relation } : null;
			})
			.filter(Boolean) as Array<{ item: ContextItem; relation: string }>;
	}

	addLinks(itemId: string, links: CaptureLink[]): void {
		const insert = this.db.transaction(() => {
			for (const link of links) {
				this.stmtAddLinks.run(itemId, link.target, link.rel, link.label ?? null);
			}
		});
		insert();
	}

	getLinks(itemId: string): CaptureLink[] {
		const rows = this.stmtGetLinks.all(itemId) as Array<{ target: string; rel: string; label: string | null }>;
		return rows.map((r) => ({
			rel: r.rel as CaptureLink["rel"],
			target: r.target,
			...(r.label !== null ? { label: r.label } : {}),
		}));
	}

	getBacklinks(target: string): Array<{ sourceId: string; rel: string; label?: string }> {
		const rows = this.stmtGetBacklinks.all(target) as Array<{
			source_id: string;
			rel: string;
			label: string | null;
		}>;
		return rows.map((r) => ({
			sourceId: r.source_id,
			rel: r.rel,
			...(r.label !== null ? { label: r.label } : {}),
		}));
	}

	incrementUsedCount(id: string): void {
		this.stmtIncrementUsedCount.run(id);
	}

	incrementIgnoredCount(id: string): void {
		this.stmtIncrementIgnoredCount.run(id);
	}

	getArchiveCandidates(): ContextItem[] {
		const rows = this.stmtGetArchiveCandidates.all() as any[];
		return rows.map((row) => this.rowToItem(row));
	}

	close(): void {
		this.db.close();
	}

	private rowToItem(row: any): ContextItem {
		return {
			id: row.id,
			content: row.content,
			contentHash: row.content_hash,
			createdAt: row.created_at,
			lastAccess: row.last_access,
			accessCount: row.access_count,
			usedCount: row.used_count ?? 0,
			ignoredCount: row.ignored_count ?? 0,
			decayScore: row.decay_score,
			cognitiveWeight: row.cognitive_weight,
			stability: row.stability ?? 0.5,
			difficulty: row.difficulty ?? 0.5,
			type: row.type,
			tags: JSON.parse(row.tags),
			pinned: row.pinned === 1,
			kgPointer: row.kg_pointer ?? undefined,
			dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
			validFrom: row.valid_from ?? undefined,
			validUntil: row.valid_until ?? undefined,
			source: row.source ?? "auto",
			sourceToolCallId: row.source_tool_call_id ?? undefined,
			resourceMtime: row.resource_mtime ?? undefined,
			resourceHash: row.resource_hash ?? undefined,
		};
	}
}

export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function createItem(
	content: string,
	type: ContextItem["type"],
	tags: string[] = [],
	toolCallId?: string,
): ContextItem {
	const now = Date.now();
	const hash = hashContent(content);

	return {
		id: `${type}_${hash}_${now}`,
		content,
		contentHash: hash,
		createdAt: now,
		lastAccess: now,
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
		decayScore: 0,
		cognitiveWeight: 0,
		stability: defaultFSRS.getInitialStability(type),
		difficulty: 0.5,
		type,
		tags,
		pinned: false,
		source: "auto",
		sourceToolCallId: toolCallId,
	};
}
