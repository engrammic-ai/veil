/**
 * SQLite ColdStore - default adapter.
 * Zero external deps, just works.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export interface SqliteColdStoreConfig extends ColdStoreConfig {
	dbPath: string;
}

export class SqliteColdStore implements ColdStore {
	private db: Database.Database;
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: false, // no embeddings
		temporal: true, // we store timestamps
		provenance: false, // no evidence chains
	};

	constructor(config: SqliteColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		mkdirSync(dirname(config.dbPath), { recursive: true });
		this.db = new Database(config.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.init();
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS cold_items (
				pointer TEXT PRIMARY KEY,
				namespace TEXT NOT NULL,

				id TEXT NOT NULL,
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL,

				created_at REAL NOT NULL,
				last_access REAL NOT NULL,
				access_count INTEGER DEFAULT 1,

				decay_score REAL DEFAULT 0.0,
				cognitive_weight REAL DEFAULT 0.0,

				type TEXT NOT NULL,
				tags TEXT NOT NULL,
				pinned INTEGER DEFAULT 0,

				depends_on TEXT,
				valid_from REAL,
				valid_until REAL,

				demoted_at REAL NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_cold_namespace ON cold_items(namespace);
			CREATE INDEX IF NOT EXISTS idx_cold_type ON cold_items(type);
		`);
	}

	async demote(item: ContextItem): Promise<string> {
		const pointer = `cold_${randomUUID()}`;

		const stmt = this.db.prepare(`
			INSERT INTO cold_items (
				pointer, namespace,
				id, content, content_hash,
				created_at, last_access, access_count,
				decay_score, cognitive_weight,
				type, tags, pinned,
				depends_on, valid_from, valid_until,
				demoted_at
			) VALUES (
				?, ?,
				?, ?, ?,
				?, ?, ?,
				?, ?,
				?, ?, ?,
				?, ?, ?,
				?
			)
		`);

		stmt.run(
			pointer,
			this.namespace,
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
			item.dependsOn ? JSON.stringify(item.dependsOn) : null,
			item.validFrom ?? null,
			item.validUntil ?? null,
			Date.now(),
		);

		return pointer;
	}

	async fetch(pointer: string): Promise<ContextItem | null> {
		const row = this.db
			.prepare("SELECT * FROM cold_items WHERE pointer = ? AND namespace = ?")
			.get(pointer, this.namespace) as any;

		if (!row) return null;

		// Update access tracking
		this.db
			.prepare("UPDATE cold_items SET last_access = ?, access_count = access_count + 1 WHERE pointer = ?")
			.run(Date.now(), pointer);

		return this.rowToItem(row);
	}

	async delete(pointer: string): Promise<void> {
		this.db.prepare("DELETE FROM cold_items WHERE pointer = ? AND namespace = ?").run(pointer, this.namespace);
	}

	async exists(pointer: string): Promise<boolean> {
		const row = this.db
			.prepare("SELECT 1 FROM cold_items WHERE pointer = ? AND namespace = ?")
			.get(pointer, this.namespace);
		return row !== undefined;
	}

	async close(): Promise<void> {
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
			type: row.type as ContextItem["type"],
			tags: JSON.parse(row.tags),
			pinned: row.pinned === 1,
			kgPointer: row.pointer,
			dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
			validFrom: row.valid_from ?? undefined,
			validUntil: row.valid_until ?? undefined,
		};
	}
}
