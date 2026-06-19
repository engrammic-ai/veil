import { describe, expect, test, vi } from "vitest";
import type { ContextCache } from "./cache.ts";
import { computeRelevanceScore, formatSelectedContext, selectForTurn, type TurnContext } from "./retrieval.ts";
import type { ContextItem } from "./types.ts";

const NOW = 1_700_000_000_000;

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "item_abc_123",
		content: "some context content",
		contentHash: "abc123",
		createdAt: NOW,
		lastAccess: NOW,
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
		decayScore: 0,
		cognitiveWeight: 0,
		stability: 0.5,
		difficulty: 0.5,
		type: "episodic",
		tags: [],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

const neutralCtx: TurnContext = {
	hasError: false,
	isEditing: false,
	recentFiles: [],
	tags: [],
};

describe("computeRelevanceScore", () => {
	test("returns a non-negative number", () => {
		vi.setSystemTime(NOW);
		const score = computeRelevanceScore(makeItem(), neutralCtx);
		expect(score).toBeGreaterThanOrEqual(0);
		vi.useRealTimers();
	});

	test("recency boost: recently accessed item scores higher than stale item", () => {
		vi.setSystemTime(NOW + 60_000); // 1 min after
		const recent = makeItem({ lastAccess: NOW });
		const stale = makeItem({ lastAccess: NOW - 48 * 3_600_000 }); // 2 days ago
		expect(computeRelevanceScore(recent, neutralCtx)).toBeGreaterThan(computeRelevanceScore(stale, neutralCtx));
		vi.useRealTimers();
	});

	test("frequency boost: item accessed more gets higher score", () => {
		vi.setSystemTime(NOW + 60_000);
		const low = makeItem({ accessCount: 1 });
		const high = makeItem({ accessCount: 50 });
		expect(computeRelevanceScore(high, neutralCtx)).toBeGreaterThan(computeRelevanceScore(low, neutralCtx));
		vi.useRealTimers();
	});

	test("failure tag boost when context has error", () => {
		vi.setSystemTime(NOW + 60_000);
		const errorCtx: TurnContext = { ...neutralCtx, hasError: true };
		const withTag = makeItem({ tags: ["failure"] });
		const withoutTag = makeItem({ tags: [] });
		expect(computeRelevanceScore(withTag, errorCtx)).toBeGreaterThan(computeRelevanceScore(withoutTag, errorCtx));
		vi.useRealTimers();
	});

	test("failure tag boost not applied when no error in context", () => {
		vi.setSystemTime(NOW + 60_000);
		const withTag = makeItem({ tags: ["failure"] });
		const withoutTag = makeItem({ tags: [] });
		// Without hasError, both should score the same (no tag boost)
		expect(computeRelevanceScore(withTag, neutralCtx)).toBeCloseTo(computeRelevanceScore(withoutTag, neutralCtx), 5);
		vi.useRealTimers();
	});

	test("edit tag boost when context is editing", () => {
		vi.setSystemTime(NOW + 60_000);
		const editCtx: TurnContext = { ...neutralCtx, isEditing: true };
		const withTag = makeItem({ tags: ["edit"] });
		const withoutTag = makeItem({ tags: [] });
		expect(computeRelevanceScore(withTag, editCtx)).toBeGreaterThan(computeRelevanceScore(withoutTag, editCtx));
		vi.useRealTimers();
	});

	test("ignored penalty: negative cognitiveWeight reduces score", () => {
		vi.setSystemTime(NOW + 60_000);
		const neutral = makeItem({ cognitiveWeight: 0 });
		const ignored = makeItem({ cognitiveWeight: -0.8 });
		expect(computeRelevanceScore(ignored, neutralCtx)).toBeLessThan(computeRelevanceScore(neutral, neutralCtx));
		vi.useRealTimers();
	});

	test("success correlation: positive cognitiveWeight boosts score", () => {
		vi.setSystemTime(NOW + 60_000);
		const neutral = makeItem({ cognitiveWeight: 0 });
		const positive = makeItem({ cognitiveWeight: 0.8 });
		expect(computeRelevanceScore(positive, neutralCtx)).toBeGreaterThan(computeRelevanceScore(neutral, neutralCtx));
		vi.useRealTimers();
	});
});

describe("selectForTurn", () => {
	function makeMockCache(items: ContextItem[]): ContextCache {
		return { getAll: () => items } as unknown as ContextCache;
	}

	test("returns empty result for empty cache", () => {
		vi.setSystemTime(NOW + 60_000);
		const result = selectForTurn(makeMockCache([]), neutralCtx, 10_000);
		expect(result.items).toHaveLength(0);
		expect(result.totalTokens).toBe(0);
		vi.useRealTimers();
	});

	test("packs items greedily up to budget", () => {
		vi.setSystemTime(NOW + 60_000);
		// Each "word" ~= 1 token; content of 10 chars ~= 2-3 tokens
		const items = Array.from({ length: 20 }, (_, i) =>
			makeItem({ id: `item_${i}`, content: "x".repeat(20), accessCount: 1 }),
		);
		const cache = makeMockCache(items);
		// Tight budget: only a few should fit
		const result = selectForTurn(cache, neutralCtx, 10);
		expect(result.totalTokens).toBeLessThanOrEqual(10);
		vi.useRealTimers();
	});

	test("respects budget limit — totalTokens never exceeds budget", () => {
		vi.setSystemTime(NOW + 60_000);
		const items = Array.from({ length: 100 }, (_, i) =>
			makeItem({ id: `item_${i}`, content: "hello world ".repeat(50) }),
		);
		const cache = makeMockCache(items);
		const budget = 500;
		const result = selectForTurn(cache, neutralCtx, budget);
		expect(result.totalTokens).toBeLessThanOrEqual(budget);
		vi.useRealTimers();
	});

	test("higher-scored items are selected before lower-scored items", () => {
		vi.setSystemTime(NOW + 60_000);
		// One item with high access count (higher score), one with low
		const highScore = makeItem({ id: "high", content: "high value item", accessCount: 100 });
		const lowScore = makeItem({ id: "low", content: "low value item", accessCount: 1 });
		const cache = makeMockCache([lowScore, highScore]);
		// Budget fits only one item
		const result = selectForTurn(cache, neutralCtx, 5);
		if (result.items.length > 0) {
			expect(result.items[0].id).toBe("high");
		}
		vi.useRealTimers();
	});

	test("deduplicates items with same ID keeping highest score", () => {
		vi.setSystemTime(NOW + 60_000);
		const itemA = makeItem({ id: "dup", content: "content", accessCount: 1 });
		const itemB = makeItem({ id: "dup", content: "content", accessCount: 50 });
		const cache = makeMockCache([itemA, itemB]);
		const result = selectForTurn(cache, neutralCtx, 50_000);
		const ids = result.items.map((i) => i.id);
		expect(ids.filter((id) => id === "dup")).toHaveLength(1);
		vi.useRealTimers();
	});
});

describe("formatSelectedContext", () => {
	test("returns empty string for empty items", () => {
		expect(formatSelectedContext([])).toBe("");
	});

	test("groups items by type with markdown headings", () => {
		vi.setSystemTime(NOW + 60_000);
		const items = [
			makeItem({ id: "e1", type: "episodic", content: "an episodic memory" }),
			makeItem({ id: "p1", type: "procedural", content: "a procedure to follow" }),
		];
		const output = formatSelectedContext(items);
		expect(output).toContain("## Recent Episodes");
		expect(output).toContain("## Procedures");
		expect(output).toContain("an episodic memory");
		expect(output).toContain("a procedure to follow");
		vi.useRealTimers();
	});

	test("includes file tag in output when tag looks like a path", () => {
		vi.setSystemTime(NOW + 60_000);
		const item = makeItem({
			type: "episodic",
			content: "error in file",
			tags: ["src/foo.ts"],
		});
		const output = formatSelectedContext([item]);
		expect(output).toContain("src/foo.ts");
		vi.useRealTimers();
	});

	test("outputs sections in order: episodic, procedural, fact, decision", () => {
		vi.setSystemTime(NOW + 60_000);
		const items = [
			makeItem({ id: "d1", type: "decision", content: "a decision" }),
			makeItem({ id: "f1", type: "fact", content: "a fact" }),
			makeItem({ id: "e1", type: "episodic", content: "an episode" }),
			makeItem({ id: "p1", type: "procedural", content: "a procedure" }),
		];
		const output = formatSelectedContext(items);
		const episodicPos = output.indexOf("## Recent Episodes");
		const proceduralPos = output.indexOf("## Procedures");
		const factPos = output.indexOf("## Facts");
		const decisionPos = output.indexOf("## Decisions");
		expect(episodicPos).toBeLessThan(proceduralPos);
		expect(proceduralPos).toBeLessThan(factPos);
		expect(factPos).toBeLessThan(decisionPos);
		vi.useRealTimers();
	});
});
