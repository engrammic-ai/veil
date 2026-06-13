/**
 * SQLite warm cache for context items.
 * Fast local storage for recent/frequent items.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { ContextItem } from "./types.ts";

export class ContextCache {
	private db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.init();
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
				valid_until REAL
			);

			CREATE INDEX IF NOT EXISTS idx_last_access ON items(last_access);
			CREATE INDEX IF NOT EXISTS idx_decay_score ON items(decay_score);
			CREATE INDEX IF NOT EXISTS idx_type ON items(type);
			CREATE INDEX IF NOT EXISTS idx_tags ON items(tags);
		`);
	}

	put(item: ContextItem): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO items (
				id, content, content_hash,
				created_at, last_access, access_count,
				decay_score, cognitive_weight,
				type, tags, pinned,
				kg_pointer, depends_on,
				valid_from, valid_until
			) VALUES (
				?, ?, ?,
				?, ?, ?,
				?, ?,
				?, ?, ?,
				?, ?,
				?, ?
			)
		`);

		stmt.run(
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
		);
	}

	get(id: string): ContextItem | null {
		const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as any;
		if (!row) return null;
		return this.rowToItem(row);
	}

	getAll(): ContextItem[] {
		const rows = this.db.prepare("SELECT * FROM items").all() as any[];
		return rows.map((row) => this.rowToItem(row));
	}

	getByTags(tags: string[], limit: number = 100): ContextItem[] {
		// Simple tag matching - items containing any of the tags
		const placeholders = tags.map(() => "tags LIKE ?").join(" OR ");
		const params = tags.map((t) => `%"${t}"%`);

		const rows = this.db
			.prepare(`SELECT * FROM items WHERE ${placeholders} ORDER BY last_access DESC LIMIT ?`)
			.all(...params, limit) as any[];

		return rows.map((row) => this.rowToItem(row));
	}

	getByHash(hash: string): ContextItem | null {
		const row = this.db.prepare("SELECT * FROM items WHERE content_hash = ?").get(hash) as any;
		if (!row) return null;
		return this.rowToItem(row);
	}

	delete(id: string): void {
		this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
	}

	touch(id: string): void {
		const now = Date.now();
		this.db.prepare("UPDATE items SET last_access = ?, access_count = access_count + 1 WHERE id = ?").run(now, id);
	}

	updateCognitiveWeight(id: string, delta: number): void {
		this.db
			.prepare(`
				UPDATE items
				SET cognitive_weight = MAX(-1, MIN(1, cognitive_weight * 0.95 + ?))
				WHERE id = ?
			`)
			.run(delta, id);
	}

	applyDecay(decayFactor: number = 0.95): void {
		this.db.prepare("UPDATE items SET decay_score = decay_score + (1 - ?) WHERE decay_score < 1").run(decayFactor);
	}

	pruneByDecay(threshold: number = 0.9): string[] {
		const rows = this.db.prepare("SELECT id FROM items WHERE decay_score >= ?").all(threshold) as any[];
		const ids = rows.map((r) => r.id);

		if (ids.length > 0) {
			this.db.prepare(`DELETE FROM items WHERE decay_score >= ?`).run(threshold);
		}

		return ids;
	}

	getStale(maxAgeMs: number, maxAccessCount: number = 1): ContextItem[] {
		const cutoff = Date.now() - maxAgeMs;
		const rows = this.db
			.prepare("SELECT * FROM items WHERE last_access < ? AND access_count <= ?")
			.all(cutoff, maxAccessCount) as any[];

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
		};
	}
}

export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function createItem(content: string, type: ContextItem["type"], tags: string[] = []): ContextItem {
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
	};
}
