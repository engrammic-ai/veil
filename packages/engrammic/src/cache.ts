/**
 * SQLite warm cache for context items.
 * Fast local storage for recent/frequent items.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { ContextItem } from "./types.ts";

export class ContextCache {
	private db: Database.Database;

	// Prepared statements (initialised once in constructor, reused on every call)
	private stmtPut: Database.Statement;
	private stmtGet: Database.Statement;
	private stmtGetByHash: Database.Statement;
	private stmtTouch: Database.Statement;
	private stmtUpdateCognitiveWeight: Database.Statement;
	private stmtDelete: Database.Statement;
	private stmtGetAll: Database.Statement;
	private stmtGetStale: Database.Statement;
	private stmtApplyDecay: Database.Statement;
	private stmtPruneByDecaySelect: Database.Statement;
	private stmtPruneByDecayDelete: Database.Statement;
	private stmtGetAllByRecency: Database.Statement;
	private stmtGetTypeCounts: Database.Statement;
	private stmtMarkEvicting: Database.Statement;
	private stmtUnmarkEvicting: Database.Statement;
	private stmtDeleteEvicting: Database.Statement;
	private stmtRecoverEvicting: Database.Statement;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.init();

		this.stmtPut = this.db.prepare(`
			INSERT OR REPLACE INTO items (
				id, content, content_hash,
				created_at, last_access, access_count,
				decay_score, cognitive_weight,
				type, tags, pinned,
				kg_pointer, depends_on,
				valid_from, valid_until,
				source, source_tool_call_id
			) VALUES (
				?, ?, ?,
				?, ?, ?,
				?, ?,
				?, ?, ?,
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

				type TEXT CHECK(type IN ('episodic', 'procedural', 'fact')) NOT NULL,
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

		// Index must be created after migration adds the column
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_tool_call_id ON items(source_tool_call_id)");
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
			item.type,
			JSON.stringify(item.tags),
			item.pinned ? 1 : 0,
			item.kgPointer ?? null,
			item.dependsOn ? JSON.stringify(item.dependsOn) : null,
			item.validFrom ?? null,
			item.validUntil ?? null,
			item.source,
			item.sourceToolCallId ?? null,
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

	getByHash(hash: string): ContextItem | null {
		const row = this.stmtGetByHash.get(hash) as any;
		if (!row) return null;
		return this.rowToItem(row);
	}

	delete(id: string): void {
		this.stmtDelete.run(id);
	}

	touch(id: string): void {
		const now = Date.now();
		this.stmtTouch.run(now, id);
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
			decayScore: row.decay_score,
			cognitiveWeight: row.cognitive_weight,
			type: row.type,
			tags: JSON.parse(row.tags),
			pinned: row.pinned === 1,
			kgPointer: row.kg_pointer ?? undefined,
			dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
			validFrom: row.valid_from ?? undefined,
			validUntil: row.valid_until ?? undefined,
			source: row.source ?? "auto",
			sourceToolCallId: row.source_tool_call_id ?? undefined,
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
		decayScore: 0,
		cognitiveWeight: 0,
		type,
		tags,
		pinned: false,
		source: "auto",
		sourceToolCallId: toolCallId,
	};
}
