/**
 * Structural floor for preloaded context items.
 *
 * When an item is preloaded, it gets a temporary minimum score that decays
 * over N turns. This prevents the "preload thrash" problem: without a floor,
 * a preloaded item that the scorer doesn't immediately value will be evicted
 * before the agent has a chance to use it.
 *
 * Floor decay: score(turn) = initialScore * 0.8^turn
 * After MAX_TURNS turns the floor expires and returns 0.
 *
 * When the agent explicitly accesses an item, call removeFloor() so that
 * normal scoring takes over (the item's access count / recency will reflect
 * real usage and the floor is no longer needed).
 */

import type Database from "better-sqlite3";

const DEFAULT_MAX_TURNS = 5;
const DECAY_RATE = 0.8;

export interface FloorEntry {
	itemId: string;
	initialScore: number;
	createdTurn: number;
}

export class StructuralFloor {
	private db: Database.Database;
	private maxTurns: number;

	private stmtAdd: Database.Statement;
	private stmtGet: Database.Statement;
	private stmtRemove: Database.Statement;
	private stmtGetAll: Database.Statement;
	private stmtPruneExpired: Database.Statement;

	constructor(db: Database.Database, maxTurns: number = DEFAULT_MAX_TURNS) {
		this.db = db;
		this.maxTurns = maxTurns;

		// Ensure table exists with index for pruning
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS structural_floor (
				item_id TEXT PRIMARY KEY,
				initial_score REAL NOT NULL,
				created_turn INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_structural_floor_turn
				ON structural_floor(created_turn);
		`);

		this.stmtAdd = this.db.prepare(`
			INSERT OR REPLACE INTO structural_floor (item_id, initial_score, created_turn)
			VALUES (?, ?, ?)
		`);

		this.stmtGet = this.db.prepare(`
			SELECT item_id, initial_score, created_turn
			FROM structural_floor
			WHERE item_id = ?
		`);

		this.stmtRemove = this.db.prepare(`
			DELETE FROM structural_floor WHERE item_id = ?
		`);

		this.stmtGetAll = this.db.prepare(`
			SELECT item_id, initial_score, created_turn FROM structural_floor
		`);

		// Remove rows whose floor has expired (age >= maxTurns)
		this.stmtPruneExpired = this.db.prepare(`
			DELETE FROM structural_floor WHERE ? - created_turn >= ?
		`);
	}

	/**
	 * Register that an item was preloaded at the given turn with an initial
	 * floor score. Idempotent: calling again refreshes the floor.
	 */
	addFloor(itemId: string, turn: number, initialScore: number): void {
		this.stmtAdd.run(itemId, initialScore, turn);
	}

	/**
	 * Return the current floor score for an item.
	 *
	 * score(age) = initialScore * DECAY_RATE^age
	 *
	 * Returns 0 if:
	 * - the item has no registered floor
	 * - the floor has expired (age >= maxTurns)
	 */
	getFloorScore(itemId: string, currentTurn: number): number {
		const row = this.stmtGet.get(itemId) as
			| { item_id: string; initial_score: number; created_turn: number }
			| undefined;

		if (!row) return 0;

		const age = currentTurn - row.created_turn;
		if (age >= this.maxTurns) return 0;

		return row.initial_score * DECAY_RATE ** age;
	}

	/**
	 * Remove the floor for an item. Call this when the agent explicitly
	 * accesses the item so normal scoring takes over.
	 */
	removeFloor(itemId: string): void {
		this.stmtRemove.run(itemId);
	}

	/**
	 * Return all active floor entries (for inspection / debugging).
	 */
	getAll(): FloorEntry[] {
		const rows = this.stmtGetAll.all() as Array<{
			item_id: string;
			initial_score: number;
			created_turn: number;
		}>;
		return rows.map((r) => ({
			itemId: r.item_id,
			initialScore: r.initial_score,
			createdTurn: r.created_turn,
		}));
	}

	/**
	 * Delete all expired floor entries (age >= maxTurns).
	 * Call periodically (e.g. on the turn tick) to keep the table small.
	 */
	pruneExpired(currentTurn: number): number {
		const result = this.stmtPruneExpired.run(currentTurn, this.maxTurns);
		return result.changes;
	}
}
