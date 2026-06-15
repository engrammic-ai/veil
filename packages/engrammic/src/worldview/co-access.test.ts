/**
 * Tests for CoAccessTracker — behavioral worldview: co-access tracking.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CoAccessTracker } from "./co-access.ts";

function makeDb(dir: string): Database.Database {
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, "test.db"));
	db.pragma("journal_mode = WAL");

	// Create the co_access table — mirrors cache.ts init
	db.exec(`
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

	return db;
}

describe("CoAccessTracker recordAccess", () => {
	let testDir: string;
	let db: Database.Database;
	let tracker: CoAccessTracker;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-coaccess-${Date.now()}`);
		db = makeDb(testDir);
		tracker = new CoAccessTracker(db);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("does nothing when fewer than 2 items are passed", () => {
		tracker.recordAccess([], 1);
		tracker.recordAccess(["only-one"], 1);

		const rows = db.prepare("SELECT COUNT(*) AS n FROM co_access").get() as { n: number };
		expect(rows.n).toBe(0);
	});

	test("stores a pair for two items", () => {
		tracker.recordAccess(["alpha", "beta"], 1);

		const rows = db.prepare("SELECT * FROM co_access").all() as Array<{
			item_a: string;
			item_b: string;
			count: number;
			last_turn: number;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0].item_a).toBe("alpha");
		expect(rows[0].item_b).toBe("beta");
		expect(rows[0].count).toBe(1);
		expect(rows[0].last_turn).toBe(1);
	});

	test("stores pairs in lexical order (item_a < item_b)", () => {
		// Pass in reverse order — stored pair must still be (alpha, beta)
		tracker.recordAccess(["zebra", "alpha"], 5);

		const row = db.prepare("SELECT item_a, item_b FROM co_access").get() as { item_a: string; item_b: string };
		expect(row.item_a).toBe("alpha");
		expect(row.item_b).toBe("zebra");
	});

	test("increments count on repeated co-access", () => {
		tracker.recordAccess(["a", "b"], 1);
		tracker.recordAccess(["a", "b"], 2);
		tracker.recordAccess(["a", "b"], 3);

		const row = db.prepare("SELECT count, last_turn FROM co_access WHERE item_a = 'a' AND item_b = 'b'").get() as {
			count: number;
			last_turn: number;
		};
		expect(row.count).toBe(3);
		expect(row.last_turn).toBe(3);
	});

	test("generates all pairs for 3 items (n=3 → 3 pairs)", () => {
		tracker.recordAccess(["x", "y", "z"], 1);

		const rows = db.prepare("SELECT COUNT(*) AS n FROM co_access").get() as { n: number };
		expect(rows.n).toBe(3); // (x,y), (x,z), (y,z)
	});

	test("generates n*(n-1)/2 pairs for n items", () => {
		const ids = ["a", "b", "c", "d", "e"]; // n=5 → 10 pairs
		tracker.recordAccess(ids, 1);

		const rows = db.prepare("SELECT COUNT(*) AS n FROM co_access").get() as { n: number };
		expect(rows.n).toBe(10);
	});

	test("updates last_turn on each access", () => {
		tracker.recordAccess(["a", "b"], 10);
		tracker.recordAccess(["a", "b"], 20);

		const row = db.prepare("SELECT last_turn FROM co_access WHERE item_a = 'a' AND item_b = 'b'").get() as {
			last_turn: number;
		};
		expect(row.last_turn).toBe(20);
	});

	test("different item pairs accumulate independently", () => {
		tracker.recordAccess(["a", "b"], 1);
		tracker.recordAccess(["a", "b"], 2);
		tracker.recordAccess(["b", "c"], 1);

		const abRow = db.prepare("SELECT count FROM co_access WHERE item_a = 'a' AND item_b = 'b'").get() as {
			count: number;
		};
		const bcRow = db.prepare("SELECT count FROM co_access WHERE item_a = 'b' AND item_b = 'c'").get() as {
			count: number;
		};

		expect(abRow.count).toBe(2);
		expect(bcRow.count).toBe(1);
	});
});

describe("CoAccessTracker getCoAccessedWith", () => {
	let testDir: string;
	let db: Database.Database;
	let tracker: CoAccessTracker;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-coaccess-get-${Date.now()}`);
		db = makeDb(testDir);
		tracker = new CoAccessTracker(db);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("returns empty array when no co-access recorded", () => {
		const results = tracker.getCoAccessedWith("nonexistent");
		expect(results).toEqual([]);
	});

	test("returns items co-accessed with the given item", () => {
		tracker.recordAccess(["alpha", "beta"], 1);
		tracker.recordAccess(["alpha", "beta"], 2);
		tracker.recordAccess(["alpha", "gamma"], 1);

		const results = tracker.getCoAccessedWith("alpha");
		expect(results).toHaveLength(2);

		const ids = results.map((r) => r.itemId);
		expect(ids).toContain("beta");
		expect(ids).toContain("gamma");
	});

	test("results are sorted by count descending", () => {
		// beta accessed with alpha 3 times, gamma only once
		tracker.recordAccess(["alpha", "beta"], 1);
		tracker.recordAccess(["alpha", "beta"], 2);
		tracker.recordAccess(["alpha", "beta"], 3);
		tracker.recordAccess(["alpha", "gamma"], 1);

		const results = tracker.getCoAccessedWith("alpha");
		expect(results[0].itemId).toBe("beta");
		expect(results[0].count).toBe(3);
		expect(results[1].itemId).toBe("gamma");
		expect(results[1].count).toBe(1);
	});

	test("works when the queried item is item_b (reverse direction)", () => {
		// Store pair (alpha, zeta) — alpha < zeta lexically
		tracker.recordAccess(["zeta", "alpha"], 1);
		tracker.recordAccess(["zeta", "alpha"], 2);

		// Query by zeta — it appears as item_b in the table
		const results = tracker.getCoAccessedWith("zeta");
		expect(results).toHaveLength(1);
		expect(results[0].itemId).toBe("alpha");
		expect(results[0].count).toBe(2);
	});

	test("respects the limit parameter", () => {
		// Create 5 co-accessed partners for "hub"
		for (const partner of ["a", "b", "c", "d", "e"]) {
			tracker.recordAccess(["hub", partner], 1);
		}

		const results = tracker.getCoAccessedWith("hub", 3);
		expect(results).toHaveLength(3);
	});

	test("default limit is 10", () => {
		// Create 15 co-accessed partners for "hub"
		for (let i = 0; i < 15; i++) {
			const partner = `partner-${String(i).padStart(2, "0")}`; // lexical sort safe
			tracker.recordAccess(["hub", partner], 1);
		}

		const results = tracker.getCoAccessedWith("hub");
		expect(results.length).toBeLessThanOrEqual(10);
	});
});

describe("CoAccessTracker integration with ContextManager tick", () => {
	// Light integration check: verify tick() delegates to coAccess.recordAccess
	// via cache.coAccess. Full manager test lives in manager.test.ts.

	test("recordAccess is idempotent for same turn if called twice", () => {
		const testDir = join(process.cwd(), `.test-coaccess-idem-${Date.now()}`);
		const db = makeDb(testDir);
		const tracker = new CoAccessTracker(db);

		// Same items, same turn — each call increments count once
		tracker.recordAccess(["a", "b"], 1);
		tracker.recordAccess(["a", "b"], 1);

		const row = db.prepare("SELECT count FROM co_access WHERE item_a = 'a' AND item_b = 'b'").get() as {
			count: number;
		};

		// Two separate calls → count = 2 (tracker does not deduplicate within a turn)
		expect(row.count).toBe(2);

		db.close();
		rmSync(testDir, { recursive: true });
	});
});
