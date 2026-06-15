import { describe, expect, test, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { StructuralFloor } from "./structural-floor.ts";
import { computeRelevance, findEvictionCandidates } from "../scorer.ts";
import type { ContextItem, TaskContext } from "../types.ts";
import { DEFAULT_CONFIG } from "../types.ts";

// --- helpers ---

function makeDb(): Database.Database {
	return new Database(":memory:");
}

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	const now = Date.now();
	return {
		id: "item_abc_1",
		content: "preloaded file content",
		contentHash: "abc123",
		createdAt: now,
		// Simulate a file that was just preloaded but not yet read by agent:
		// last access is old so recency is low.
		lastAccess: now - 2 * 60 * 60 * 1000, // 2 hours ago
		accessCount: 1,
		decayScore: 0,
		cognitiveWeight: 0,
		type: "episodic",
		tags: [],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

const TASK_CTX: TaskContext = { tags: [] };

// ──────────────────────────────────────────────────────────────────────────────
// StructuralFloor unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("StructuralFloor", () => {
	let db: Database.Database;
	let floor: StructuralFloor;

	beforeEach(() => {
		db = makeDb();
		floor = new StructuralFloor(db, 5);
	});

	afterEach(() => {
		db.close();
	});

	test("getFloorScore returns 0 for unknown item", () => {
		expect(floor.getFloorScore("no_such_item", 0)).toBe(0);
	});

	test("getFloorScore at turn 0 equals initialScore", () => {
		floor.addFloor("item1", 0, 0.9);
		expect(floor.getFloorScore("item1", 0)).toBeCloseTo(0.9);
	});

	test("score decays by 0.8 each turn", () => {
		floor.addFloor("item1", 0, 1.0);
		expect(floor.getFloorScore("item1", 0)).toBeCloseTo(1.0);
		expect(floor.getFloorScore("item1", 1)).toBeCloseTo(0.8);
		expect(floor.getFloorScore("item1", 2)).toBeCloseTo(0.64);
		expect(floor.getFloorScore("item1", 3)).toBeCloseTo(0.512);
	});

	test("score returns 0 when age >= maxTurns", () => {
		floor.addFloor("item1", 0, 0.9);
		// maxTurns = 5, so at turn 5 age = 5 which is >= maxTurns
		expect(floor.getFloorScore("item1", 5)).toBe(0);
		expect(floor.getFloorScore("item1", 10)).toBe(0);
	});

	test("score is still active at turn maxTurns - 1", () => {
		floor.addFloor("item1", 0, 0.9);
		// age = 4 < 5 → still active
		expect(floor.getFloorScore("item1", 4)).toBeGreaterThan(0);
	});

	test("removeFloor eliminates the floor", () => {
		floor.addFloor("item1", 0, 0.9);
		floor.removeFloor("item1");
		expect(floor.getFloorScore("item1", 0)).toBe(0);
	});

	test("addFloor is idempotent / refreshes entry", () => {
		floor.addFloor("item1", 0, 0.5);
		// Refresh with higher score at turn 2
		floor.addFloor("item1", 2, 0.9);
		// age from turn 2 at current turn 2 = 0
		expect(floor.getFloorScore("item1", 2)).toBeCloseTo(0.9);
	});

	test("getAll returns all registered floors", () => {
		floor.addFloor("a", 0, 0.8);
		floor.addFloor("b", 1, 0.6);
		const entries = floor.getAll();
		expect(entries).toHaveLength(2);
		const ids = entries.map((e) => e.itemId).sort();
		expect(ids).toEqual(["a", "b"]);
	});

	test("pruneExpired removes expired entries", () => {
		floor.addFloor("old_item", 0, 0.9); // age 10 >= maxTurns(5) → expired
		floor.addFloor("new_item", 8, 0.9); // age 2 < 5 → still active
		const removed = floor.pruneExpired(10);
		expect(removed).toBe(1);
		expect(floor.getAll()).toHaveLength(1);
		expect(floor.getAll()[0].itemId).toBe("new_item");
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: scorer respects structural floor
// ──────────────────────────────────────────────────────────────────────────────

describe("computeRelevance with structural floor", () => {
	let db: Database.Database;
	let floor: StructuralFloor;

	beforeEach(() => {
		db = makeDb();
		floor = new StructuralFloor(db, 5);
	});

	afterEach(() => {
		db.close();
	});

	test("score is floor when floor > computed", () => {
		const item = makeItem(); // stale item → low computed score
		const computedWithoutFloor = computeRelevance(item, TASK_CTX, DEFAULT_CONFIG);

		const initialFloor = 0.85;
		floor.addFloor(item.id, 0, initialFloor);

		const scoreWithFloor = computeRelevance(item, TASK_CTX, DEFAULT_CONFIG, undefined, floor, 0);
		expect(scoreWithFloor).toBeGreaterThan(computedWithoutFloor);
		expect(scoreWithFloor).toBeCloseTo(initialFloor);
	});

	test("score is computed when computed > floor", () => {
		// Fresh item with high access count → high computed score
		const item = makeItem({ lastAccess: Date.now(), accessCount: 50, source: "explicit" });
		const computedWithoutFloor = computeRelevance(item, TASK_CTX, DEFAULT_CONFIG);

		// Set a low floor that won't dominate
		floor.addFloor(item.id, 0, 0.1);
		const scoreWithFloor = computeRelevance(item, TASK_CTX, DEFAULT_CONFIG, undefined, floor, 0);
		expect(scoreWithFloor).toBeCloseTo(computedWithoutFloor);
	});

	test("score is computed after floor expires", () => {
		const item = makeItem();
		const initialFloor = 0.85;
		floor.addFloor(item.id, 0, initialFloor);

		// At turn 5 the floor expires (age 5 >= maxTurns 5)
		const scoreAfterExpiry = computeRelevance(item, TASK_CTX, DEFAULT_CONFIG, undefined, floor, 5);
		const computedWithoutFloor = computeRelevance(item, TASK_CTX, DEFAULT_CONFIG);
		expect(scoreAfterExpiry).toBeCloseTo(computedWithoutFloor);
	});

	test("floor prevents item from appearing in eviction candidates", () => {
		const item = makeItem(); // stale → normally evicted
		const config = { ...DEFAULT_CONFIG, evictionThreshold: 0.5 };

		// Without floor: the stale item should appear as eviction candidate
		const candidatesNoFloor = findEvictionCandidates([item], TASK_CTX, config);
		expect(candidatesNoFloor.length).toBeGreaterThan(0);

		// With floor at 0.85: item's effective score is 0.85, above threshold
		floor.addFloor(item.id, 0, 0.85);
		const candidatesWithFloor = findEvictionCandidates([item], TASK_CTX, config, floor, 0);
		expect(candidatesWithFloor).toHaveLength(0);
	});

	test("floor does not affect other items", () => {
		const itemA = makeItem({ id: "item_a" });
		const itemB = makeItem({ id: "item_b" });

		floor.addFloor(itemA.id, 0, 0.85);

		const scoreA = computeRelevance(itemA, TASK_CTX, DEFAULT_CONFIG, undefined, floor, 0);
		const scoreB = computeRelevance(itemB, TASK_CTX, DEFAULT_CONFIG, undefined, floor, 0);

		// A gets boosted, B does not
		expect(scoreA).toBeGreaterThan(scoreB);
	});
});
