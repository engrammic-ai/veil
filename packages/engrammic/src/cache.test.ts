import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type HydrationEvent, ContextCache, createItem } from "./cache.ts";

describe("ContextCache two-phase commit", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("markEvicting sets evicting flag", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);
		cache.markEvicting(item.id);
		const stuck = cache.recoverEvicting();
		expect(stuck).toHaveLength(1);
		expect(stuck[0].id).toBe(item.id);
	});

	test("unmarkEvicting clears evicting flag", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);
		cache.markEvicting(item.id);
		cache.unmarkEvicting(item.id);
		const stuck = cache.recoverEvicting();
		expect(stuck).toHaveLength(0);
	});

	test("deleteEvicting removes item", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);
		cache.markEvicting(item.id);
		cache.deleteEvicting(item.id);
		expect(cache.get(item.id)).toBeNull();
	});

	test("recoverEvicting finds stuck items", () => {
		const item1 = createItem("test 1", "episodic", ["tag"]);
		const item2 = createItem("test 2", "episodic", ["tag"]);
		cache.put(item1);
		cache.put(item2);
		cache.markEvicting(item1.id);
		const stuck = cache.recoverEvicting();
		expect(stuck).toHaveLength(1);
		expect(stuck[0].id).toBe(item1.id);
	});
});

describe("ContextCache hydration events", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-hydration-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("logHydration stores an event and getRecentHydrations retrieves it", () => {
		const event: HydrationEvent = {
			sessionId: "sess-1",
			itemId: "item-abc",
			triggerIds: ["trigger-1", "trigger-2"],
			userMessage: "What is the weather?",
			hydratedAt: 1700000000,
			latencyMs: 42,
		};
		cache.logHydration(event);

		const results = cache.getRecentHydrations(10);
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(event);
	});

	test("getRecentHydrations respects limit and orders by recency", () => {
		for (let i = 0; i < 5; i++) {
			cache.logHydration({
				sessionId: "sess-1",
				itemId: `item-${i}`,
				triggerIds: [],
				userMessage: "msg",
				hydratedAt: 1700000000 + i,
				latencyMs: i * 10,
			});
		}

		const results = cache.getRecentHydrations(3);
		expect(results).toHaveLength(3);
		// Most recent first
		expect(results[0].itemId).toBe("item-4");
		expect(results[1].itemId).toBe("item-3");
		expect(results[2].itemId).toBe("item-2");
	});

	test("logHydration deduplicates on UNIQUE(session_id, item_id, hydrated_at)", () => {
		const event: HydrationEvent = {
			sessionId: "sess-1",
			itemId: "item-abc",
			triggerIds: ["t1"],
			userMessage: "hello",
			hydratedAt: 1700000000,
			latencyMs: 5,
		};
		cache.logHydration(event);
		cache.logHydration(event); // should be ignored

		expect(cache.getRecentHydrations(10)).toHaveLength(1);
	});

	test("getHydrationStats returns count and avgLatency for an item", () => {
		cache.logHydration({ sessionId: "s1", itemId: "item-x", triggerIds: [], userMessage: "a", hydratedAt: 1, latencyMs: 100 });
		cache.logHydration({ sessionId: "s1", itemId: "item-x", triggerIds: [], userMessage: "b", hydratedAt: 2, latencyMs: 200 });

		const stats = cache.getHydrationStats("item-x");
		expect(stats.count).toBe(2);
		expect(stats.avgLatency).toBe(150);
	});

	test("getHydrationStats returns zero for unknown item", () => {
		const stats = cache.getHydrationStats("nonexistent");
		expect(stats.count).toBe(0);
		expect(stats.avgLatency).toBe(0);
	});
});
