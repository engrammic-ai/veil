import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type HydrationEvent, ContextCache, createItem } from "./cache.ts";
import type { Trigger } from "./types.ts";

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

describe("ContextCache custom triggers", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-triggers-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("persistTrigger stores a trigger and loadCustomTriggers retrieves it", () => {
		const trigger: Trigger = {
			id: "trigger-1",
			pattern: /typescript/,
			type: "keyword",
			action: { tags: ["ts", "types"] },
			priority: 5,
			enabled: true,
			learned: false,
		};
		cache.persistTrigger(trigger);

		const results = cache.loadCustomTriggers();
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("trigger-1");
		expect(results[0].pattern.source).toBe("typescript");
		expect(results[0].type).toBe("keyword");
		expect(results[0].action.tags).toEqual(["ts", "types"]);
		expect(results[0].priority).toBe(5);
		expect(results[0].enabled).toBe(true);
		expect(results[0].learned).toBe(false);
	});

	test("persistTrigger stores negative pattern and confidence", () => {
		const trigger: Trigger = {
			id: "trigger-2",
			pattern: /deploy/,
			negative: /staging/,
			type: "command",
			action: { type: "procedural" },
			priority: 10,
			enabled: true,
			learned: true,
			confidence: 0.87,
		};
		cache.persistTrigger(trigger);

		const results = cache.loadCustomTriggers();
		expect(results).toHaveLength(1);
		expect(results[0].negative).toBeDefined();
		expect(results[0].negative!.source).toBe("staging");
		expect(results[0].action.type).toBe("procedural");
		expect(results[0].learned).toBe(true);
		expect(results[0].confidence).toBeCloseTo(0.87);
	});

	test("persistTrigger uses INSERT OR REPLACE to update existing trigger", () => {
		const trigger: Trigger = {
			id: "trigger-3",
			pattern: /git/,
			type: "command",
			action: { tags: ["vcs"] },
			priority: 3,
			enabled: true,
		};
		cache.persistTrigger(trigger);

		const updated: Trigger = { ...trigger, priority: 7 };
		cache.persistTrigger(updated);

		const results = cache.loadCustomTriggers();
		expect(results).toHaveLength(1);
		expect(results[0].priority).toBe(7);
	});

	test("loadCustomTriggers only returns enabled triggers", () => {
		const enabled: Trigger = {
			id: "trigger-enabled",
			pattern: /active/,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: true,
		};
		const disabled: Trigger = {
			id: "trigger-disabled",
			pattern: /inactive/,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: false,
		};
		cache.persistTrigger(enabled);
		cache.persistTrigger(disabled);

		const results = cache.loadCustomTriggers();
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("trigger-enabled");
	});

	test("deleteTrigger removes the trigger", () => {
		const trigger: Trigger = {
			id: "trigger-to-delete",
			pattern: /remove-me/,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: true,
		};
		cache.persistTrigger(trigger);
		expect(cache.loadCustomTriggers()).toHaveLength(1);

		cache.deleteTrigger("trigger-to-delete");
		expect(cache.loadCustomTriggers()).toHaveLength(0);
	});

	test("deleteTrigger is a no-op for nonexistent id", () => {
		const trigger: Trigger = {
			id: "trigger-x",
			pattern: /hello/,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: true,
		};
		cache.persistTrigger(trigger);
		cache.deleteTrigger("nonexistent-id");

		expect(cache.loadCustomTriggers()).toHaveLength(1);
	});

	test("pattern flags are preserved exactly on reload", () => {
		const triggerNoFlags: Trigger = {
			id: "trigger-no-flags",
			pattern: /React/,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: true,
		};
		cache.persistTrigger(triggerNoFlags);

		const results = cache.loadCustomTriggers();
		// No flags — case-sensitive, so 'react' should NOT match /React/
		expect(results[0].pattern.flags).toBe("");
		expect(results[0].pattern.test("React")).toBe(true);
		expect(results[0].pattern.test("react")).toBe(false);
	});

	test("case-insensitive flag is preserved on reload", () => {
		const trigger: Trigger = {
			id: "trigger-i-flag",
			pattern: /React/i,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: true,
		};
		cache.persistTrigger(trigger);

		const results = cache.loadCustomTriggers();
		expect(results[0].pattern.flags).toContain("i");
		expect(results[0].pattern.test("react")).toBe(true);
		expect(results[0].pattern.test("REACT")).toBe(true);
	});

	test("created_at is preserved when updating an existing trigger", () => {
		const trigger: Trigger = {
			id: "trigger-created-at",
			pattern: /hello/,
			type: "keyword",
			action: {},
			priority: 1,
			enabled: true,
		};
		cache.persistTrigger(trigger);

		// Read created_at from DB directly via loadCustomTriggers (not exposed, so query raw)
		const dbFirst = (cache as any).db.prepare(
			"SELECT created_at, updated_at FROM custom_triggers WHERE id = ?",
		).get("trigger-created-at") as { created_at: number; updated_at: number };
		const originalCreatedAt = dbFirst.created_at;

		// Small delay to ensure updated_at would differ
		const before = Date.now();
		while (Date.now() <= before) { /* spin until clock advances */ }

		const updated: Trigger = { ...trigger, priority: 99 };
		cache.persistTrigger(updated);

		const dbSecond = (cache as any).db.prepare(
			"SELECT created_at, updated_at FROM custom_triggers WHERE id = ?",
		).get("trigger-created-at") as { created_at: number; updated_at: number };

		expect(dbSecond.created_at).toBe(originalCreatedAt);
		expect(dbSecond.updated_at).toBeGreaterThan(originalCreatedAt);

		const results = cache.loadCustomTriggers();
		expect(results[0].priority).toBe(99);
	});
});
