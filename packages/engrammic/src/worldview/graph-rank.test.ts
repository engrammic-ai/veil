/**
 * Tests for graph-rank.ts — PageRank-based file ranking.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SYMBOL_GRAPH_SCHEMA } from "./symbol-store.ts";
import { STRUCTURAL_RANK_SCHEMA, RankStore, buildFileGraph, computePageRank, updateRanks } from "./graph-rank.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(dir: string): Database.Database {
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, "test.db"));
	db.pragma("journal_mode = WAL");

	// Create symbol_graph table (mirrors cache.ts init)
	db.exec(SYMBOL_GRAPH_SCHEMA);

	return db;
}

/** Insert a reference row (file -> target_file via symbol). */
function insertRef(
	db: Database.Database,
	file: string,
	symbol: string,
	targetFile: string,
	line = 1,
): void {
	db.prepare(
		`INSERT OR REPLACE INTO symbol_graph (file, symbol, kind, target_file, target_symbol, line)
     VALUES (?, ?, 'ref', ?, NULL, ?)`,
	).run(file, symbol, targetFile, line);
}

/** Insert a definition row (file exports a symbol). */
function insertDef(db: Database.Database, file: string, symbol: string, line = 1): void {
	db.prepare(
		`INSERT OR REPLACE INTO symbol_graph (file, symbol, kind, target_file, target_symbol, line)
     VALUES (?, ?, 'def', NULL, NULL, ?)`,
	).run(file, symbol, line);
}

// ---------------------------------------------------------------------------
// buildFileGraph
// ---------------------------------------------------------------------------

describe("buildFileGraph", () => {
	let testDir: string;
	let db: Database.Database;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-graph-rank-build-${Date.now()}`);
		db = makeDb(testDir);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("returns empty graph when symbol_graph is empty", () => {
		const graph = buildFileGraph(db);
		expect(graph.order).toBe(0);
		expect(graph.size).toBe(0);
	});

	test("adds nodes for def-only files (no refs)", () => {
		insertDef(db, "src/a.ts", "fnA");
		const graph = buildFileGraph(db);
		expect(graph.hasNode("src/a.ts")).toBe(true);
		expect(graph.size).toBe(0); // no edges
	});

	test("adds edge from ref file to target_file", () => {
		insertRef(db, "src/consumer.ts", "fnA", "src/provider.ts");
		const graph = buildFileGraph(db);

		expect(graph.hasNode("src/consumer.ts")).toBe(true);
		expect(graph.hasNode("src/provider.ts")).toBe(true);
		expect(graph.hasEdge("src/consumer.ts", "src/provider.ts")).toBe(true);
		expect(graph.size).toBe(1);
	});

	test("skips refs with null target_file", () => {
		db.prepare(
			`INSERT OR REPLACE INTO symbol_graph (file, symbol, kind, target_file, target_symbol, line)
       VALUES ('src/foo.ts', 'localFn', 'ref', NULL, NULL, 5)`,
		).run();
		const graph = buildFileGraph(db);
		expect(graph.size).toBe(0);
	});

	test("skips self-referencing edges (file -> same file)", () => {
		insertRef(db, "src/self.ts", "helperFn", "src/self.ts");
		const graph = buildFileGraph(db);
		expect(graph.size).toBe(0);
		// The node should still appear if it has defs
	});

	test("deduplicates multiple refs between the same pair of files", () => {
		insertRef(db, "src/a.ts", "fn1", "src/b.ts", 1);
		insertRef(db, "src/a.ts", "fn2", "src/b.ts", 2);
		insertRef(db, "src/a.ts", "fn3", "src/b.ts", 3);

		const graph = buildFileGraph(db);
		expect(graph.size).toBe(1); // only one edge regardless of how many refs
	});

	test("builds multi-node graph with several files", () => {
		// a -> b, a -> c, b -> c
		insertRef(db, "src/a.ts", "B", "src/b.ts");
		insertRef(db, "src/a.ts", "C", "src/c.ts");
		insertRef(db, "src/b.ts", "C2", "src/c.ts");

		const graph = buildFileGraph(db);
		expect(graph.order).toBe(3);
		expect(graph.size).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// computePageRank
// ---------------------------------------------------------------------------

describe("computePageRank", () => {
	let testDir: string;
	let db: Database.Database;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-graph-rank-pr-${Date.now()}`);
		db = makeDb(testDir);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("returns empty Map for an empty graph", () => {
		const graph = buildFileGraph(db);
		const scores = computePageRank(graph);
		expect(scores.size).toBe(0);
	});

	test("returns a score for every node", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");
		insertDef(db, "src/c.ts", "fnC");

		const graph = buildFileGraph(db);
		const scores = computePageRank(graph);

		expect(scores.has("src/a.ts")).toBe(true);
		expect(scores.has("src/b.ts")).toBe(true);
		expect(scores.has("src/c.ts")).toBe(true);
	});

	test("scores sum to approximately 1", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");
		insertRef(db, "src/b.ts", "fn", "src/c.ts");

		const graph = buildFileGraph(db);
		const scores = computePageRank(graph);

		const total = [...scores.values()].reduce((s, v) => s + v, 0);
		expect(total).toBeCloseTo(1, 5);
	});

	test("hub file (pointed to by many) gets higher score", () => {
		// a, b, c all reference hub; hub references nothing
		insertRef(db, "src/a.ts", "fn", "src/hub.ts");
		insertRef(db, "src/b.ts", "fn", "src/hub.ts");
		insertRef(db, "src/c.ts", "fn", "src/hub.ts");

		const graph = buildFileGraph(db);
		const scores = computePageRank(graph);

		const hubScore = scores.get("src/hub.ts")!;
		const aScore = scores.get("src/a.ts")!;

		expect(hubScore).toBeGreaterThan(aScore);
	});

	test("isolated node (no edges) gets uniform score", () => {
		insertDef(db, "src/isolated.ts", "fn");
		const graph = buildFileGraph(db);
		const scores = computePageRank(graph);

		// Single-node graph — score should be 1 (all mass on one node)
		expect(scores.get("src/isolated.ts")).toBeCloseTo(1, 5);
	});
});

// ---------------------------------------------------------------------------
// RankStore
// ---------------------------------------------------------------------------

describe("RankStore", () => {
	let testDir: string;
	let db: Database.Database;
	let store: RankStore;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-graph-rank-store-${Date.now()}`);
		db = makeDb(testDir);
		store = new RankStore(db);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("getRank returns null for unknown file", () => {
		expect(store.getRank("src/nonexistent.ts")).toBeNull();
	});

	test("saveRanks persists scores", () => {
		const scores = new Map([
			["src/a.ts", 0.6],
			["src/b.ts", 0.4],
		]);
		store.saveRanks(scores);

		const rowA = store.getRank("src/a.ts");
		expect(rowA).not.toBeNull();
		expect(rowA!.pagerank).toBeCloseTo(0.6, 10);
		expect(rowA!.task_bias).toBe(0);
	});

	test("saveRanks updates existing rows on re-run", () => {
		store.saveRanks(new Map([["src/a.ts", 0.5]]));
		store.saveRanks(new Map([["src/a.ts", 0.9]]));

		const row = store.getRank("src/a.ts");
		expect(row!.pagerank).toBeCloseTo(0.9, 10);
	});

	test("saveRanks preserves task_bias on update", () => {
		store.saveRanks(new Map([["src/a.ts", 0.5]]));

		// Manually set task_bias
		db.prepare("UPDATE structural_rank SET task_bias = 0.25 WHERE file = 'src/a.ts'").run();

		// Re-run saveRanks — task_bias should NOT be clobbered
		store.saveRanks(new Map([["src/a.ts", 0.8]]));

		const row = store.getRank("src/a.ts");
		expect(row!.task_bias).toBeCloseTo(0.25, 10);
		expect(row!.pagerank).toBeCloseTo(0.8, 10);
	});

	test("getAllRanks returns rows ordered by pagerank descending", () => {
		store.saveRanks(
			new Map([
				["src/low.ts", 0.1],
				["src/high.ts", 0.7],
				["src/mid.ts", 0.3],
			]),
		);

		const rows = store.getAllRanks();
		expect(rows).toHaveLength(3);
		expect(rows[0].file).toBe("src/high.ts");
		expect(rows[1].file).toBe("src/mid.ts");
		expect(rows[2].file).toBe("src/low.ts");
	});

	test("getAllRanks returns empty array when no ranks stored", () => {
		expect(store.getAllRanks()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// updateRanks (full pipeline)
// ---------------------------------------------------------------------------

describe("updateRanks", () => {
	let testDir: string;
	let db: Database.Database;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-graph-rank-update-${Date.now()}`);
		db = makeDb(testDir);
		// structural_rank table needs to exist (normally created by cache.ts init)
		db.exec(STRUCTURAL_RANK_SCHEMA);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("returns 0 when symbol_graph is empty", () => {
		const count = updateRanks(db);
		expect(count).toBe(0);
	});

	test("returns count of ranked files", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");
		insertDef(db, "src/c.ts", "fnC");

		const count = updateRanks(db);
		expect(count).toBe(3); // a, b, c
	});

	test("writes pagerank scores to structural_rank table", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");

		updateRanks(db);

		const rows = db.prepare("SELECT * FROM structural_rank ORDER BY pagerank DESC").all() as Array<{
			file: string;
			pagerank: number;
			task_bias: number;
		}>;
		expect(rows.length).toBeGreaterThan(0);

		const files = rows.map((r) => r.file);
		expect(files).toContain("src/a.ts");
		expect(files).toContain("src/b.ts");

		for (const row of rows) {
			expect(row.task_bias).toBe(0);
			expect(row.pagerank).toBeGreaterThan(0);
		}
	});

	test("is idempotent — running twice produces same final scores", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");

		updateRanks(db);
		const rowsFirst = db
			.prepare("SELECT file, pagerank FROM structural_rank ORDER BY file")
			.all() as Array<{ file: string; pagerank: number }>;

		updateRanks(db);
		const rowsSecond = db
			.prepare("SELECT file, pagerank FROM structural_rank ORDER BY file")
			.all() as Array<{ file: string; pagerank: number }>;

		expect(rowsFirst).toHaveLength(rowsSecond.length);
		for (let i = 0; i < rowsFirst.length; i++) {
			expect(rowsFirst[i].file).toBe(rowsSecond[i].file);
			expect(rowsFirst[i].pagerank).toBeCloseTo(rowsSecond[i].pagerank, 10);
		}
	});
});
