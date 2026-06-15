/**
 * Tests for unified-anticipate.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { UnifiedAnticipator } from "./unified-anticipate.ts";
import type { ScoredSuggestion } from "./unified-anticipate.ts";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

interface SymbolRow {
	symbol: string;
	kind: "def" | "ref";
	file: string;
	target_file: string | null;
}

function makeSymbolStore(rows: SymbolRow[]) {
	return {
		getSymbolsForFile: (file: string) => rows.filter((r) => r.file === file),
		getReferencesTo: (symbol: string) =>
			rows.filter((r) => r.kind === "ref" && r.symbol === symbol).map((r) => ({ file: r.file })),
	} as any;
}

function makeRankStore(scores: Record<string, number>) {
	return {
		getEffectiveRank: (file: string) => scores[file] ?? null,
	} as any;
}

function makeCoAccessTracker(entries: Record<string, Array<{ itemId: string; count: number }>>) {
	return {
		getCoAccessedWith: (itemId: string, _limit: number) => entries[itemId] ?? [],
	} as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnifiedAnticipator", () => {
	describe("getSuggestions", () => {
		it("returns empty array for empty accessedItems", () => {
			const anticipator = new UnifiedAnticipator(
				makeSymbolStore([]),
				makeRankStore({}),
				makeCoAccessTracker({}),
			);
			expect(anticipator.getSuggestions([])).toEqual([]);
		});

		it("returns empty array when limit is 0", () => {
			const anticipator = new UnifiedAnticipator(
				makeSymbolStore([]),
				makeRankStore({}),
				makeCoAccessTracker({}),
			);
			expect(anticipator.getSuggestions(["a.ts"], { limit: 0 })).toEqual([]);
		});

		it("returns structural-only suggestions when no behavioral data", () => {
			const symbolStore = makeSymbolStore([
				{ symbol: "Foo", kind: "ref", file: "main.ts", target_file: "foo.ts" },
				{ symbol: "Bar", kind: "ref", file: "main.ts", target_file: "bar.ts" },
			]);
			const rankStore = makeRankStore({ "foo.ts": 0.8, "bar.ts": 0.4 });
			const coAccess = makeCoAccessTracker({});

			const anticipator = new UnifiedAnticipator(symbolStore, rankStore, coAccess);
			const results = anticipator.getSuggestions(["main.ts"]);

			expect(results.length).toBeGreaterThan(0);
			// foo.ts should rank higher (higher pagerank)
			const ids = results.map((r) => r.itemId);
			expect(ids.indexOf("foo.ts")).toBeLessThan(ids.indexOf("bar.ts"));
			// Source should be structural only
			expect(results[0].sources).toContain("structural");
		});

		it("returns behavioral-only suggestions when no structural data", () => {
			const symbolStore = makeSymbolStore([]);
			const rankStore = makeRankStore({});
			const coAccess = makeCoAccessTracker({
				"main.ts": [
					{ itemId: "utils.ts", count: 10 },
					{ itemId: "types.ts", count: 5 },
				],
			});

			const anticipator = new UnifiedAnticipator(symbolStore, rankStore, coAccess);
			const results = anticipator.getSuggestions(["main.ts"]);

			expect(results.length).toBeGreaterThan(0);
			const ids = results.map((r) => r.itemId);
			expect(ids).toContain("utils.ts");
			expect(ids).toContain("types.ts");
			// utils.ts should rank higher (higher count)
			expect(ids.indexOf("utils.ts")).toBeLessThan(ids.indexOf("types.ts"));
			expect(results[0].sources).toContain("behavioral");
		});

		it("blends both signals and marks sources correctly", () => {
			const symbolStore = makeSymbolStore([
				{ symbol: "Foo", kind: "ref", file: "main.ts", target_file: "structural-only.ts" },
				{ symbol: "Bar", kind: "ref", file: "main.ts", target_file: "both.ts" },
			]);
			const rankStore = makeRankStore({ "structural-only.ts": 1.0, "both.ts": 0.5 });
			const coAccess = makeCoAccessTracker({
				"main.ts": [
					{ itemId: "behavioral-only.ts", count: 20 },
					{ itemId: "both.ts", count: 10 },
				],
			});

			const anticipator = new UnifiedAnticipator(symbolStore, rankStore, coAccess);
			const results = anticipator.getSuggestions(["main.ts"]);

			const byId = Object.fromEntries(results.map((r) => [r.itemId, r]));

			// "both.ts" should have both sources
			expect(byId["both.ts"]).toBeDefined();
			expect(byId["both.ts"].sources).toContain("structural");
			expect(byId["both.ts"].sources).toContain("behavioral");

			// "structural-only.ts" should have only structural source
			expect(byId["structural-only.ts"]).toBeDefined();
			expect(byId["structural-only.ts"].sources).toEqual(["structural"]);

			// "behavioral-only.ts" should have only behavioral source
			expect(byId["behavioral-only.ts"]).toBeDefined();
			expect(byId["behavioral-only.ts"].sources).toEqual(["behavioral"]);
		});

		it("excludes already-accessed items from suggestions", () => {
			const symbolStore = makeSymbolStore([
				{ symbol: "Foo", kind: "ref", file: "main.ts", target_file: "already-loaded.ts" },
			]);
			const rankStore = makeRankStore({ "already-loaded.ts": 1.0 });
			const coAccess = makeCoAccessTracker({
				"main.ts": [{ itemId: "already-loaded.ts", count: 10 }],
			});

			const anticipator = new UnifiedAnticipator(symbolStore, rankStore, coAccess);
			const results = anticipator.getSuggestions(["main.ts", "already-loaded.ts"]);

			const ids = results.map((r) => r.itemId);
			expect(ids).not.toContain("already-loaded.ts");
		});

		it("respects the limit option", () => {
			const coAccess = makeCoAccessTracker({
				"main.ts": [
					{ itemId: "a.ts", count: 10 },
					{ itemId: "b.ts", count: 9 },
					{ itemId: "c.ts", count: 8 },
					{ itemId: "d.ts", count: 7 },
					{ itemId: "e.ts", count: 6 },
				],
			});

			const anticipator = new UnifiedAnticipator(
				makeSymbolStore([]),
				makeRankStore({}),
				coAccess,
			);
			const results = anticipator.getSuggestions(["main.ts"], { limit: 3 });
			expect(results.length).toBe(3);
		});

		it("respects custom weight options", () => {
			// Give structural-only candidate a high rank and behavioral-only a high count.
			// With behavioralWeight=1, structural=0 the behavioral candidate should win.
			const symbolStore = makeSymbolStore([
				{ symbol: "Foo", kind: "ref", file: "main.ts", target_file: "struct.ts" },
			]);
			const rankStore = makeRankStore({ "struct.ts": 1.0 });
			const coAccess = makeCoAccessTracker({
				"main.ts": [{ itemId: "behav.ts", count: 100 }],
			});

			const anticipator = new UnifiedAnticipator(symbolStore, rankStore, coAccess);

			const pureStructural = anticipator.getSuggestions(["main.ts"], {
				structuralWeight: 1.0,
				behavioralWeight: 0.0,
			});
			expect(pureStructural[0].itemId).toBe("struct.ts");

			const pureBehavioral = anticipator.getSuggestions(["main.ts"], {
				structuralWeight: 0.0,
				behavioralWeight: 1.0,
			});
			expect(pureBehavioral[0].itemId).toBe("behav.ts");
		});

		it("scores are in range [0, 1] for valid inputs", () => {
			const symbolStore = makeSymbolStore([
				{ symbol: "X", kind: "ref", file: "a.ts", target_file: "b.ts" },
			]);
			const rankStore = makeRankStore({ "b.ts": 0.5 });
			const coAccess = makeCoAccessTracker({
				"a.ts": [{ itemId: "c.ts", count: 5 }],
			});

			const anticipator = new UnifiedAnticipator(symbolStore, rankStore, coAccess);
			const results = anticipator.getSuggestions(["a.ts"]);

			for (const r of results) {
				expect(r.score).toBeGreaterThanOrEqual(0);
				expect(r.score).toBeLessThanOrEqual(1);
			}
		});

		it("aggregates behavioral counts across multiple accessed items", () => {
			// c.ts is co-accessed with both a.ts and b.ts, should rank higher than d.ts
			const coAccess = makeCoAccessTracker({
				"a.ts": [
					{ itemId: "c.ts", count: 3 },
					{ itemId: "d.ts", count: 1 },
				],
				"b.ts": [{ itemId: "c.ts", count: 2 }],
			});

			const anticipator = new UnifiedAnticipator(
				makeSymbolStore([]),
				makeRankStore({}),
				coAccess,
			);
			const results = anticipator.getSuggestions(["a.ts", "b.ts"]);
			const ids = results.map((r) => r.itemId);

			expect(ids.indexOf("c.ts")).toBeLessThan(ids.indexOf("d.ts"));
		});
	});
});
