/**
 * Co-access tracker for the behavioral worldview.
 *
 * Records which context items are accessed together within the same turn.
 * This feeds anticipatory loading: if A and B are frequently co-accessed,
 * loading A should preload B.
 *
 * Pairs are stored with item_a < item_b (lexical order) to avoid duplicates.
 */

import type * as BetterSqlite3 from "better-sqlite3";

export interface CoAccessEntry {
	itemId: string;
	count: number;
}

export class CoAccessTracker {
	private db: BetterSqlite3.Database;
	private stmtUpsert: BetterSqlite3.Statement;
	private stmtGetByA: BetterSqlite3.Statement;
	private stmtGetByB: BetterSqlite3.Statement;

	constructor(db: BetterSqlite3.Database) {
		this.db = db;
		this.stmtUpsert = this.db.prepare(`
			INSERT INTO co_access (item_a, item_b, count, last_turn)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(item_a, item_b) DO UPDATE SET
				count = count + 1,
				last_turn = excluded.last_turn
		`);

		this.stmtGetByA = this.db.prepare(`
			SELECT item_b AS item_id, count
			FROM co_access
			WHERE item_a = ?
			ORDER BY count DESC
			LIMIT ?
		`);

		this.stmtGetByB = this.db.prepare(`
			SELECT item_a AS item_id, count
			FROM co_access
			WHERE item_b = ?
			ORDER BY count DESC
			LIMIT ?
		`);
	}

	/**
	 * Record that a set of items were accessed together in the given turn.
	 * Generates all pairs (A < B) and increments their co-access count.
	 *
	 * O(n^2) pair generation — callers should pass only the set of items
	 * that are actually active in this turn (typically small, < 50).
	 */
	recordAccess(itemIds: string[], turn: number): void {
		if (itemIds.length < 2) return;

		const upsert = this.stmtUpsert;
		const record = this.db.transaction(() => {
			for (let i = 0; i < itemIds.length; i++) {
				for (let j = i + 1; j < itemIds.length; j++) {
					const a = itemIds[i] < itemIds[j] ? itemIds[i] : itemIds[j];
					const b = itemIds[i] < itemIds[j] ? itemIds[j] : itemIds[i];
					upsert.run(a, b, turn);
				}
			}
		});
		record();
	}

	/**
	 * Return items most frequently co-accessed with the given item,
	 * ordered by co-access count descending.
	 *
	 * Merges results from both directions of the pair (A,B) and (B,A).
	 */
	getCoAccessedWith(itemId: string, limit: number = 10): CoAccessEntry[] {
		const fromA = this.stmtGetByA.all(itemId, limit) as Array<{ item_id: string; count: number }>;
		const fromB = this.stmtGetByB.all(itemId, limit) as Array<{ item_id: string; count: number }>;

		// Merge and deduplicate (shouldn't overlap, but be safe)
		const merged = new Map<string, number>();
		for (const row of [...fromA, ...fromB]) {
			merged.set(row.item_id, (merged.get(row.item_id) ?? 0) + row.count);
		}

		return Array.from(merged.entries())
			.map(([itemId, count]) => ({ itemId, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, limit);
	}
}
