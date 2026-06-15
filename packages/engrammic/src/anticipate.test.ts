import { describe, expect, test, vi } from "vitest";
import {
	buildBehavioralManifest,
	buildManifest,
	DEFAULT_TRIGGERS,
	formatManifest,
	matchTriggers,
} from "./anticipate.ts";
import type { ContextItem, ContextManifest, Trigger } from "./types.ts";

// Minimal mock cache
function makeCache(items: ContextItem[] = []) {
	return {
		getByTags: vi.fn((tags: string[], _limit: number) => items.filter((i) => tags.some((t) => i.tags.includes(t)))),
		getAll: vi.fn(() => items),
	};
}

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "item-1",
		content: "some context content here",
		contentHash: "abc123",
		createdAt: Date.now() - 60000,
		lastAccess: Date.now() - 30000,
		accessCount: 1,
		decayScore: 0,
		cognitiveWeight: 0,
		type: "episodic",
		tags: ["test"],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

// -----------------------------------------------------------------------
// matchTriggers
// -----------------------------------------------------------------------

describe("matchTriggers", () => {
	test("matches positive pattern", () => {
		const triggers = DEFAULT_TRIGGERS;
		const matched = matchTriggers("can you run the tests?", triggers);
		expect(matched.some((t) => t.id === "test")).toBe(true);
	});

	test("matches debug pattern", () => {
		const matched = matchTriggers("I need help debugging this", DEFAULT_TRIGGERS);
		expect(matched.some((t) => t.id === "debug")).toBe(true);
	});

	test("matches auth pattern", () => {
		const matched = matchTriggers("fix the authentication flow", DEFAULT_TRIGGERS);
		expect(matched.some((t) => t.id === "auth")).toBe(true);
	});

	test("matches fix pattern", () => {
		const matched = matchTriggers("fixing the bug in the handler", DEFAULT_TRIGGERS);
		expect(matched.some((t) => t.id === "fix")).toBe(true);
	});

	test("negative pattern prevents match — 'test this idea'", () => {
		const matched = matchTriggers("test this idea with the new approach", DEFAULT_TRIGGERS);
		expect(matched.some((t) => t.id === "test")).toBe(false);
	});

	test("negative pattern prevents match — 'test that'", () => {
		const matched = matchTriggers("let me test that assumption", DEFAULT_TRIGGERS);
		expect(matched.some((t) => t.id === "test")).toBe(false);
	});

	test("disabled triggers are skipped", () => {
		const triggers: Trigger[] = [
			{
				id: "disabled",
				pattern: /hello/i,
				type: "keyword",
				action: { tags: ["greeting"] },
				priority: 10,
				enabled: false,
			},
		];
		const matched = matchTriggers("hello world", triggers);
		expect(matched).toHaveLength(0);
	});

	test("deduplicates triggers with overlapping actions", () => {
		const triggers: Trigger[] = [
			{
				id: "t1",
				pattern: /foo/i,
				type: "keyword",
				action: { tags: ["shared"] },
				priority: 10,
				enabled: true,
			},
			{
				id: "t2",
				pattern: /bar/i,
				type: "keyword",
				action: { tags: ["shared"] }, // same action
				priority: 5,
				enabled: true,
			},
		];
		const matched = matchTriggers("foo bar", triggers);
		// Both match but same action key → only one should be in result
		expect(matched).toHaveLength(1);
		expect(matched[0].id).toBe("t1"); // higher priority wins
	});

	test("returns triggers ordered by priority descending", () => {
		const triggers: Trigger[] = [
			{
				id: "low",
				pattern: /alpha/i,
				type: "keyword",
				action: { tags: ["low"] },
				priority: 1,
				enabled: true,
			},
			{
				id: "high",
				pattern: /alpha/i,
				type: "keyword",
				action: { tags: ["high"] },
				priority: 20,
				enabled: true,
			},
		];
		const matched = matchTriggers("alpha", triggers);
		expect(matched[0].id).toBe("high");
		expect(matched[1].id).toBe("low");
	});

	test("returns empty array when no triggers match", () => {
		const matched = matchTriggers("unrelated message", DEFAULT_TRIGGERS);
		expect(matched).toHaveLength(0);
	});

	test("returns empty array for empty trigger list", () => {
		const matched = matchTriggers("run the tests", []);
		expect(matched).toHaveLength(0);
	});
});

// -----------------------------------------------------------------------
// buildManifest
// -----------------------------------------------------------------------

describe("buildManifest", () => {
	test("returns null when no triggers", async () => {
		const cache = makeCache();
		const result = await buildManifest([], cache as any, { percent: 50 });
		expect(result).toBeNull();
	});

	test("returns null when budget > 70%", async () => {
		const trigger: Trigger = {
			id: "t",
			pattern: /foo/i,
			type: "keyword",
			action: { tags: ["foo"] },
			priority: 10,
			enabled: true,
		};
		const cache = makeCache([makeItem({ tags: ["foo"] })]);
		const result = await buildManifest([trigger], cache as any, { percent: 71 });
		expect(result).toBeNull();
	});

	test("returns null at exactly 70% budget", async () => {
		const trigger: Trigger = {
			id: "t",
			pattern: /foo/i,
			type: "keyword",
			action: { tags: ["foo"] },
			priority: 10,
			enabled: true,
		};
		const cache = makeCache([makeItem({ tags: ["foo"] })]);
		// > 70 means 70 is NOT blocked
		const result = await buildManifest([trigger], cache as any, { percent: 70 });
		expect(result).not.toBeNull();
	});

	test("queries cache by tags", async () => {
		const item = makeItem({ id: "item-tag", tags: ["auth"] });
		const cache = makeCache([item]);
		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};
		const result = await buildManifest([trigger], cache as any, { percent: 50 });
		expect(cache.getByTags).toHaveBeenCalledWith(["auth"], 10);
		expect(result).not.toBeNull();
		expect(result!.items[0].id).toBe("item-tag");
	});

	test("queries cache by type when action has type", async () => {
		const episodicItem = makeItem({ id: "ep-1", type: "episodic", tags: [] });
		const factItem = makeItem({ id: "fact-1", type: "fact", tags: [] });
		const cache = makeCache([episodicItem, factItem]);
		const trigger: Trigger = {
			id: "fix",
			pattern: /fix/i,
			type: "keyword",
			action: { type: "episodic" },
			priority: 5,
			enabled: true,
		};
		const result = await buildManifest([trigger], cache as any, { percent: 30 });
		expect(cache.getAll).toHaveBeenCalled();
		expect(result).not.toBeNull();
		expect(result!.items.every((i) => i.type === "episodic")).toBe(true);
	});

	test("limits manifest to 10 items", async () => {
		const items = Array.from({ length: 20 }, (_, k) => makeItem({ id: `item-${k}`, tags: ["test"] }));
		const cache = makeCache(items);
		// Override getByTags to return all 20
		cache.getByTags.mockImplementation(() => items);

		const trigger: Trigger = {
			id: "t",
			pattern: /foo/i,
			type: "keyword",
			action: { tags: ["test"] },
			priority: 10,
			enabled: true,
		};
		const result = await buildManifest([trigger], cache as any, { percent: 30 });
		expect(result).not.toBeNull();
		expect(result!.items).toHaveLength(10);
	});

	test("returns null when cache has no matching items", async () => {
		const cache = makeCache([]); // empty
		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};
		const result = await buildManifest([trigger], cache as any, { percent: 20 });
		expect(result).toBeNull();
	});

	test("deduplicates items across multiple triggers", async () => {
		const sharedItem = makeItem({ id: "shared", tags: ["auth", "test"] });
		const cache = makeCache([sharedItem]);
		cache.getByTags.mockImplementation(() => [sharedItem]);

		const triggers: Trigger[] = [
			{
				id: "t1",
				pattern: /auth/i,
				type: "keyword",
				action: { tags: ["auth"] },
				priority: 10,
				enabled: true,
			},
			{
				id: "t2",
				pattern: /test/i,
				type: "keyword",
				action: { tags: ["test"] },
				priority: 8,
				enabled: true,
			},
		];
		const result = await buildManifest(triggers, cache as any, { percent: 30 });
		expect(result).not.toBeNull();
		// shared item should appear only once
		const ids = result!.items.map((i) => i.id);
		expect(ids.filter((id) => id === "shared")).toHaveLength(1);
	});

	test("manifest contains trigger IDs and budget", async () => {
		const item = makeItem({ id: "ep", tags: ["debug"] });
		const cache = makeCache([item]);
		cache.getByTags.mockImplementation(() => [item]);

		const trigger: Trigger = {
			id: "debug",
			pattern: /debug/i,
			type: "keyword",
			action: { tags: ["debug"] },
			priority: 10,
			enabled: true,
		};
		const result = await buildManifest([trigger], cache as any, { percent: 45 });
		expect(result!.triggers).toContain("debug");
		expect(result!.budgetPercent).toBe(45);
	});
});

// -----------------------------------------------------------------------
// formatManifest
// -----------------------------------------------------------------------

describe("formatManifest", () => {
	test("produces correct XML wrapper and item lines", () => {
		const manifest: ContextManifest = {
			triggers: ["auth"],
			budgetPercent: 42,
			items: [
				{
					id: "item-1",
					type: "episodic",
					tags: ["auth", "session"],
					summary: "User logged in successfully",
					age: "5min ago",
				},
			],
		};

		const output = formatManifest(manifest);
		expect(output).toContain("<veil-available>");
		expect(output).toContain("</veil-available>");
		expect(output).toContain("Relevant context found (use recall to load):");
		expect(output).toContain('- item-1 [auth, session] "User logged in successfully..." (5min ago)');
		expect(output).toContain("Budget: 42% used");
	});

	test("uses only first two tags per item", () => {
		const manifest: ContextManifest = {
			triggers: ["t"],
			budgetPercent: 10,
			items: [
				{
					id: "x",
					type: "fact",
					tags: ["alpha", "beta", "gamma", "delta"],
					summary: "short summary",
					age: "1hr ago",
				},
			],
		};
		const output = formatManifest(manifest);
		expect(output).toContain("[alpha, beta]");
		expect(output).not.toContain("gamma");
		expect(output).not.toContain("delta");
	});

	test("handles empty items list", () => {
		const manifest: ContextManifest = {
			triggers: [],
			budgetPercent: 0,
			items: [],
		};
		const output = formatManifest(manifest);
		expect(output).toContain("<veil-available>");
		expect(output).toContain("</veil-available>");
		expect(output).toContain("Budget: 0% used");
	});

	test("rounds budget percent in display", () => {
		const manifest: ContextManifest = {
			triggers: [],
			budgetPercent: 66.666,
			items: [],
		};
		const output = formatManifest(manifest);
		expect(output).toContain("Budget: 67% used");
	});

	test("shows [cold] indicator for cold-source items", () => {
		const manifest: ContextManifest = {
			triggers: ["auth"],
			budgetPercent: 30,
			items: [
				{
					id: "warm-1",
					type: "episodic",
					tags: ["auth"],
					summary: "Warm cache item",
					age: "2min ago",
				},
				{
					id: "cold-1",
					type: "episodic",
					tags: ["auth"],
					summary: "Cold storage item",
					age: "3hr ago",
					source: "cold",
				},
			],
		};

		const output = formatManifest(manifest);
		expect(output).toContain('- warm-1 [auth] "Warm cache item..." (2min ago)');
		expect(output).not.toContain("warm-1 [auth]" + ' "Warm cache item..." (2min ago) [cold]');
		expect(output).toContain('- cold-1 [auth] "Cold storage item..." (3hr ago) [cold]');
	});

	test("does not show [cold] indicator for warm items", () => {
		const manifest: ContextManifest = {
			triggers: ["debug"],
			budgetPercent: 20,
			items: [
				{
					id: "warm-item",
					type: "fact",
					tags: ["debug"],
					summary: "A warm item",
					age: "5min ago",
				},
			],
		};

		const output = formatManifest(manifest);
		expect(output).not.toContain("[cold]");
	});
});

// -----------------------------------------------------------------------
// buildManifest — cold storage integration
// -----------------------------------------------------------------------

describe("buildManifest cold storage", () => {
	function makeColdItem(overrides: Partial<ContextItem> = {}): ContextItem {
		return {
			id: "cold-item-1",
			content: "cold storage content here",
			contentHash: "cold123",
			createdAt: Date.now() - 3600000,
			lastAccess: Date.now() - 1800000,
			accessCount: 1,
			decayScore: 0,
			cognitiveWeight: 0,
			type: "episodic",
			tags: ["auth"],
			pinned: false,
			source: "auto",
			...overrides,
		};
	}

	function makeColdStore(items: ContextItem[] = []) {
		return {
			query: vi.fn(async (_text: string, _tags: string[], limit: number) => items.slice(0, limit)),
			demote: vi.fn(),
			fetch: vi.fn(),
			delete: vi.fn(),
			exists: vi.fn(),
			count: vi.fn(),
			close: vi.fn(),
			capabilities: { semantic: true, temporal: false, provenance: false },
		};
	}

	test("queries cold store when budget < 40% and items < 10", async () => {
		const warmCache = makeCache([]); // empty warm cache
		const coldItem = makeColdItem({ id: "cold-1", tags: ["auth"] });
		const cold = makeColdStore([coldItem]);

		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		const result = await buildManifest([trigger], warmCache as any, { percent: 30 }, cold as any);
		expect(cold.query).toHaveBeenCalledWith("", ["auth"], 10);
		expect(result).not.toBeNull();
		expect(result!.items).toHaveLength(1);
		expect(result!.items[0].id).toBe("cold-1");
		expect(result!.items[0].source).toBe("cold");
	});

	test("cold items get source: cold", async () => {
		const warmCache = makeCache([]);
		const coldItem = makeColdItem({ id: "cold-tagged", tags: ["debug"] });
		const cold = makeColdStore([coldItem]);

		const trigger: Trigger = {
			id: "debug",
			pattern: /debug/i,
			type: "keyword",
			action: { tags: ["debug"] },
			priority: 10,
			enabled: true,
		};

		const result = await buildManifest([trigger], warmCache as any, { percent: 20 }, cold as any);
		expect(result!.items[0].source).toBe("cold");
	});

	test("does not query cold store when budget >= 40%", async () => {
		const warmItem = makeItem({ id: "warm-1", tags: ["auth"] });
		const warmCache = makeCache([warmItem]);
		const cold = makeColdStore([makeColdItem()]);

		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		await buildManifest([trigger], warmCache as any, { percent: 40 }, cold as any);
		expect(cold.query).not.toHaveBeenCalled();
	});

	test("does not query cold store when items already >= 10", async () => {
		const warmItems = Array.from({ length: 10 }, (_, k) => makeItem({ id: `warm-${k}`, tags: ["auth"] }));
		const warmCache = makeCache(warmItems);
		warmCache.getByTags.mockImplementation(() => warmItems);
		const cold = makeColdStore([makeColdItem()]);

		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		await buildManifest([trigger], warmCache as any, { percent: 30 }, cold as any);
		expect(cold.query).not.toHaveBeenCalled();
	});

	test("cold store not queried when cold is null", async () => {
		const warmCache = makeCache([]);
		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		// Should not throw, returns null because empty warm cache + no cold
		const result = await buildManifest([trigger], warmCache as any, { percent: 30 }, null);
		expect(result).toBeNull();
	});

	test("cold store not queried when cold is undefined", async () => {
		const warmCache = makeCache([]);
		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		const result = await buildManifest([trigger], warmCache as any, { percent: 30 });
		expect(result).toBeNull();
	});

	test("deduplicates between warm and cold results", async () => {
		const sharedId = "item-shared";
		const warmItem = makeItem({ id: sharedId, tags: ["auth"] });
		const warmCache = makeCache([warmItem]);
		// Cold returns same ID
		const coldItem = makeColdItem({ id: sharedId, tags: ["auth"] });
		const cold = makeColdStore([coldItem]);

		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		const result = await buildManifest([trigger], warmCache as any, { percent: 30 }, cold as any);
		expect(result).not.toBeNull();
		const ids = result!.items.map((i) => i.id);
		expect(ids.filter((id) => id === sharedId)).toHaveLength(1);
	});

	test("cold query limit is 10 minus warm items count", async () => {
		const warmItems = Array.from({ length: 7 }, (_, k) => makeItem({ id: `warm-${k}`, tags: ["auth"] }));
		const warmCache = makeCache(warmItems);
		warmCache.getByTags.mockImplementation(() => warmItems);
		const cold = makeColdStore([makeColdItem({ id: "cold-extra" })]);

		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		await buildManifest([trigger], warmCache as any, { percent: 30 }, cold as any);
		expect(cold.query).toHaveBeenCalledWith("", ["auth"], 3); // 10 - 7 = 3
	});

	test("cold query uses all trigger tags", async () => {
		const warmCache = makeCache([]);
		const cold = makeColdStore([]);

		const triggers: Trigger[] = [
			{
				id: "t1",
				pattern: /auth/i,
				type: "keyword",
				action: { tags: ["auth", "session"] },
				priority: 10,
				enabled: true,
			},
			{
				id: "t2",
				pattern: /debug/i,
				type: "keyword",
				action: { tags: ["debug"] },
				priority: 8,
				enabled: true,
			},
		];

		await buildManifest(triggers, warmCache as any, { percent: 20 }, cold as any);
		expect(cold.query).toHaveBeenCalledWith("", ["auth", "session", "debug"], 10);
	});

	test("cold store without query method is skipped", async () => {
		const warmCache = makeCache([]);
		// ColdStore without query capability
		const coldNoQuery = {
			demote: vi.fn(),
			fetch: vi.fn(),
			delete: vi.fn(),
			exists: vi.fn(),
			count: vi.fn(),
			close: vi.fn(),
			capabilities: { semantic: false, temporal: false, provenance: false },
			// No query method
		};

		const trigger: Trigger = {
			id: "auth",
			pattern: /auth/i,
			type: "keyword",
			action: { tags: ["auth"] },
			priority: 10,
			enabled: true,
		};

		// Should not throw
		const result = await buildManifest([trigger], warmCache as any, { percent: 30 }, coldNoQuery as any);
		expect(result).toBeNull();
	});
});

// -----------------------------------------------------------------------
// buildBehavioralManifest
// -----------------------------------------------------------------------

describe("buildBehavioralManifest", () => {
	function makeCacheWithGet(items: ContextItem[] = []) {
		const itemMap = new Map(items.map((i) => [i.id, i]));
		return {
			get: vi.fn((id: string) => itemMap.get(id) ?? null),
		};
	}

	function makeCoAccessTracker(coAccessMap: Record<string, Array<{ itemId: string; count: number }>> = {}) {
		return {
			getCoAccessedWith: vi.fn((itemId: string, limit: number) => {
				const entries = coAccessMap[itemId] ?? [];
				return entries.slice(0, limit);
			}),
		};
	}

	test("returns empty array when no accessed items", () => {
		const cache = makeCacheWithGet();
		const tracker = makeCoAccessTracker();
		const result = buildBehavioralManifest([], tracker as any, cache as any);
		expect(result).toEqual([]);
		expect(tracker.getCoAccessedWith).not.toHaveBeenCalled();
	});

	test("returns empty array when no co-access data exists", () => {
		const cache = makeCacheWithGet([makeItem({ id: "item-A" })]);
		const tracker = makeCoAccessTracker({}); // no entries for item-A
		const result = buildBehavioralManifest(["item-A"], tracker as any, cache as any);
		expect(result).toEqual([]);
	});

	test("returns co-accessed items found in warm cache", () => {
		const itemB = makeItem({ id: "item-B", type: "fact", tags: ["fact"], content: "fact about the system" });
		const cache = makeCacheWithGet([itemB]);
		const tracker = makeCoAccessTracker({
			"item-A": [{ itemId: "item-B", count: 5 }],
		});
		const result = buildBehavioralManifest(["item-A"], tracker as any, cache as any);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("item-B");
		expect(result[0].type).toBe("fact");
	});

	test("excludes the accessed items themselves from results", () => {
		// item-A is accessed, co-access table might list it paired with itself if mis-recorded
		// More realistically: item-B co-accessed with item-A, but item-A is in accessedSet
		const itemA = makeItem({ id: "item-A" });
		const itemB = makeItem({ id: "item-B" });
		const cache = makeCacheWithGet([itemA, itemB]);
		const tracker = makeCoAccessTracker({
			"item-A": [
				{ itemId: "item-A", count: 10 }, // self — should be excluded
				{ itemId: "item-B", count: 3 },
			],
		});
		const result = buildBehavioralManifest(["item-A"], tracker as any, cache as any);
		expect(result.map((i) => i.id)).not.toContain("item-A");
		expect(result.map((i) => i.id)).toContain("item-B");
	});

	test("deduplicates candidates across multiple accessed items", () => {
		const itemC = makeItem({ id: "item-C", content: "shared co-accessed item" });
		const cache = makeCacheWithGet([itemC]);
		const tracker = makeCoAccessTracker({
			"item-A": [{ itemId: "item-C", count: 4 }],
			"item-B": [{ itemId: "item-C", count: 6 }],
		});
		const result = buildBehavioralManifest(["item-A", "item-B"], tracker as any, cache as any);
		// item-C should appear only once despite appearing in both lookups
		expect(result.filter((i) => i.id === "item-C")).toHaveLength(1);
	});

	test("aggregates co-access counts across multiple accessed items for ranking", () => {
		const itemC = makeItem({ id: "item-C", content: "high aggregate" });
		const itemD = makeItem({ id: "item-D", content: "low aggregate" });
		const cache = makeCacheWithGet([itemC, itemD]);
		// item-C has count 3 from item-A and count 5 from item-B = 8 total
		// item-D has count 7 from item-A only = 7 total
		const tracker = makeCoAccessTracker({
			"item-A": [
				{ itemId: "item-C", count: 3 },
				{ itemId: "item-D", count: 7 },
			],
			"item-B": [{ itemId: "item-C", count: 5 }],
		});
		const result = buildBehavioralManifest(["item-A", "item-B"], tracker as any, cache as any);
		expect(result[0].id).toBe("item-C"); // higher aggregate count
		expect(result[1].id).toBe("item-D");
	});

	test("respects the limit parameter", () => {
		const items = Array.from({ length: 10 }, (_, k) => makeItem({ id: `item-${k}`, content: `content ${k}` }));
		const cache = makeCacheWithGet(items);
		const coMap: Record<string, Array<{ itemId: string; count: number }>> = {
			"item-X": items.map((i, k) => ({ itemId: i.id, count: 10 - k })),
		};
		const tracker = makeCoAccessTracker(coMap);

		const result = buildBehavioralManifest(["item-X"], tracker as any, cache as any, 3);
		expect(result).toHaveLength(3);
	});

	test("skips candidates not found in warm cache", () => {
		// co-access points to item-Z which is not in the warm cache (evicted to cold)
		const cache = makeCacheWithGet([]); // empty warm cache
		const tracker = makeCoAccessTracker({
			"item-A": [{ itemId: "item-Z", count: 10 }],
		});
		const result = buildBehavioralManifest(["item-A"], tracker as any, cache as any);
		expect(result).toEqual([]);
	});

	test("summary is first 50 chars with newlines replaced", () => {
		const itemB = makeItem({
			id: "item-B",
			content: "line one\nline two\nline three and more content here beyond fifty chars",
		});
		const cache = makeCacheWithGet([itemB]);
		const tracker = makeCoAccessTracker({
			"item-A": [{ itemId: "item-B", count: 2 }],
		});
		const result = buildBehavioralManifest(["item-A"], tracker as any, cache as any);
		expect(result[0].summary).toBe("line one line two line three and more content here");
		expect(result[0].summary.length).toBeLessThanOrEqual(50);
		expect(result[0].summary).not.toContain("\n");
	});

	test("uses default limit of 5", () => {
		const items = Array.from({ length: 8 }, (_, k) => makeItem({ id: `item-${k}`, content: `content ${k}` }));
		const cache = makeCacheWithGet(items);
		const coMap: Record<string, Array<{ itemId: string; count: number }>> = {
			"item-X": items.map((i, k) => ({ itemId: i.id, count: 8 - k })),
		};
		const tracker = makeCoAccessTracker(coMap);

		const result = buildBehavioralManifest(["item-X"], tracker as any, cache as any);
		expect(result.length).toBeLessThanOrEqual(5);
	});
});
