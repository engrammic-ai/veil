/**
 * Tests for structural-anticipate.ts — structural anticipatory loading.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { STRUCTURAL_RANK_SCHEMA, RankStore } from "./graph-rank.ts";
import { SYMBOL_GRAPH_SCHEMA, SymbolStore } from "./symbol-store.ts";
import { getStructuralSuggestions } from "./structural-anticipate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(dir: string): Database.Database {
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, "test.db"));
	db.pragma("journal_mode = WAL");
	db.exec(SYMBOL_GRAPH_SCHEMA);
	db.exec(STRUCTURAL_RANK_SCHEMA);
	return db;
}

/** Insert a 'ref' row: file references target_file via symbol. */
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

/** Insert a 'def' row: file defines a symbol. */
function insertDef(db: Database.Database, file: string, symbol: string, line = 1): void {
	db.prepare(
		`INSERT OR REPLACE INTO symbol_graph (file, symbol, kind, target_file, target_symbol, line)
     VALUES (?, ?, 'def', NULL, NULL, ?)`,
	).run(file, symbol, line);
}

// ---------------------------------------------------------------------------
// getStructuralSuggestions
// ---------------------------------------------------------------------------

describe("getStructuralSuggestions", () => {
	let testDir: string;
	let db: Database.Database;
	let symbolStore: SymbolStore;
	let rankStore: RankStore;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-struct-anticipate-${Date.now()}`);
		db = makeDb(testDir);
		symbolStore = new SymbolStore(db);
		rankStore = new RankStore(db);
	});

	afterEach(() => {
		db.close();
		rmSync(testDir, { recursive: true });
	});

	test("returns empty array when no connections exist", () => {
		// File with no refs or incoming refs
		insertDef(db, "src/island.ts", "fnIsland");
		const suggestions = getStructuralSuggestions("src/island.ts", symbolStore, rankStore);
		expect(suggestions).toEqual([]);
	});

	test("returns empty array for limit 0", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");
		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore, 0);
		expect(suggestions).toEqual([]);
	});

	test("returns files that the accessed file imports (outgoing edges)", () => {
		// a.ts references b.ts
		insertRef(db, "src/a.ts", "fnB", "src/b.ts");
		rankStore.saveRanks(new Map([["src/b.ts", 0.5]]));

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		expect(suggestions).toContain("src/b.ts");
		expect(suggestions).not.toContain("src/a.ts");
	});

	test("returns files that import the accessed file (incoming edges)", () => {
		// consumer.ts references utils.ts which defines fnUtil
		insertDef(db, "src/utils.ts", "fnUtil");
		insertRef(db, "src/consumer.ts", "fnUtil", "src/utils.ts");
		rankStore.saveRanks(new Map([["src/consumer.ts", 0.4]]));

		const suggestions = getStructuralSuggestions("src/utils.ts", symbolStore, rankStore);
		expect(suggestions).toContain("src/consumer.ts");
		expect(suggestions).not.toContain("src/utils.ts");
	});

	test("never includes the accessed file itself", () => {
		insertRef(db, "src/a.ts", "fn", "src/b.ts");
		insertDef(db, "src/a.ts", "localFn");
		rankStore.saveRanks(new Map([["src/a.ts", 0.8], ["src/b.ts", 0.5]]));

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		expect(suggestions).not.toContain("src/a.ts");
	});

	test("results are ordered by effective rank descending", () => {
		// a.ts imports b, c, d — all with different ranks
		insertRef(db, "src/a.ts", "B", "src/b.ts");
		insertRef(db, "src/a.ts", "C", "src/c.ts");
		insertRef(db, "src/a.ts", "D", "src/d.ts");

		rankStore.saveRanks(new Map([
			["src/b.ts", 0.2],
			["src/c.ts", 0.7],
			["src/d.ts", 0.4],
		]));

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		expect(suggestions[0]).toBe("src/c.ts");
		expect(suggestions[1]).toBe("src/d.ts");
		expect(suggestions[2]).toBe("src/b.ts");
	});

	test("respects the limit parameter", () => {
		// a.ts imports 5 files
		for (let i = 0; i < 5; i++) {
			insertRef(db, "src/a.ts", `fn${i}`, `src/dep${i}.ts`);
			rankStore.saveRanks(new Map([[`src/dep${i}.ts`, (i + 1) * 0.1]]));
		}

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore, 3);
		expect(suggestions).toHaveLength(3);
	});

	test("files without rank entry are treated as rank 0 and appear last", () => {
		insertRef(db, "src/a.ts", "B", "src/b.ts");
		insertRef(db, "src/a.ts", "C", "src/c.ts");

		// Only b.ts has a rank; c.ts has no rank row (defaults to 0)
		rankStore.saveRanks(new Map([["src/b.ts", 0.5]]));

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		expect(suggestions[0]).toBe("src/b.ts");
		expect(suggestions[1]).toBe("src/c.ts");
	});

	test("includes both outgoing and incoming connections", () => {
		// hub.ts is both a consumer and a provider
		// hub.ts imports lib.ts (outgoing)
		insertRef(db, "src/hub.ts", "libFn", "src/lib.ts");
		// client.ts imports hub.ts (incoming)
		insertDef(db, "src/hub.ts", "hubFn");
		insertRef(db, "src/client.ts", "hubFn", "src/hub.ts");

		rankStore.saveRanks(new Map([
			["src/lib.ts", 0.4],
			["src/client.ts", 0.3],
		]));

		const suggestions = getStructuralSuggestions("src/hub.ts", symbolStore, rankStore);
		expect(suggestions).toContain("src/lib.ts");
		expect(suggestions).toContain("src/client.ts");
	});

	test("deduplicates files that appear as both incoming and outgoing", () => {
		// shared.ts is both imported by a.ts and imports a.ts (circular)
		insertDef(db, "src/a.ts", "fnA");
		insertRef(db, "src/shared.ts", "fnA", "src/a.ts"); // shared imports a
		insertRef(db, "src/a.ts", "fnShared", "src/shared.ts"); // a imports shared

		rankStore.saveRanks(new Map([["src/shared.ts", 0.5]]));

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		const count = suggestions.filter((s) => s === "src/shared.ts").length;
		expect(count).toBe(1); // deduplicated
	});

	test("returns empty array for file with no symbol_graph entries", () => {
		// Non-existent file — no rows in symbol_graph at all
		const suggestions = getStructuralSuggestions("src/ghost.ts", symbolStore, rankStore);
		expect(suggestions).toEqual([]);
	});

	test("task bias boosts effective rank — biased file ranks ahead of higher-pagerank unbiased file", () => {
		insertRef(db, "src/a.ts", "B", "src/b.ts");
		insertRef(db, "src/a.ts", "C", "src/c.ts");

		// c has higher raw pagerank, but b gets a large task bias
		rankStore.saveRanks(new Map([
			["src/b.ts", 0.2],
			["src/c.ts", 0.5],
		]));
		rankStore.updateBias("src/b.ts", 1.0); // effective = 0.2 * (1 + 1.0) = 0.4

		// b effective = 0.4, c effective = 0.5 * 1 = 0.5 → c still wins
		// Let's use a bigger bias to flip the order
		rankStore.updateBias("src/b.ts", 2.0); // effective = 0.2 * 3 = 0.6 > 0.5
		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		expect(suggestions[0]).toBe("src/b.ts");
	});

	test("default limit is 5", () => {
		// a.ts imports 8 files — without explicit limit, should cap at 5
		for (let i = 0; i < 8; i++) {
			insertRef(db, "src/a.ts", `fn${i}`, `src/dep${i}.ts`);
		}

		const suggestions = getStructuralSuggestions("src/a.ts", symbolStore, rankStore);
		expect(suggestions.length).toBeLessThanOrEqual(5);
	});
});
