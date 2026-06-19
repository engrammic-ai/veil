import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContextCache, createItem, type HydrationEvent } from "./cache.ts";
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
		cache.logHydration({
			sessionId: "s1",
			itemId: "item-x",
			triggerIds: [],
			userMessage: "a",
			hydratedAt: 1,
			latencyMs: 100,
		});
		cache.logHydration({
			sessionId: "s1",
			itemId: "item-x",
			triggerIds: [],
			userMessage: "b",
			hydratedAt: 2,
			latencyMs: 200,
		});

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
		vi.useFakeTimers();
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
		const dbFirst = (cache as any).db
			.prepare("SELECT created_at, updated_at FROM custom_triggers WHERE id = ?")
			.get("trigger-created-at") as { created_at: number; updated_at: number };
		const originalCreatedAt = dbFirst.created_at;

		// Advance fake clock so updated_at will differ from created_at
		vi.advanceTimersByTime(100);

		const updated: Trigger = { ...trigger, priority: 99 };
		cache.persistTrigger(updated);

		const dbSecond = (cache as any).db
			.prepare("SELECT created_at, updated_at FROM custom_triggers WHERE id = ?")
			.get("trigger-created-at") as { created_at: number; updated_at: number };

		expect(dbSecond.created_at).toBe(originalCreatedAt);
		expect(dbSecond.updated_at).toBeGreaterThan(originalCreatedAt);

		const results = cache.loadCustomTriggers();
		expect(results[0].priority).toBe(99);

		vi.useRealTimers();
	});
});

describe("ContextCache episode links", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-episodes-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("linkEpisodes creates a link and getRelatedEpisodes returns the linked item", () => {
		const source = createItem("source episode", "episodic", ["a"]);
		const target = createItem("target episode", "episodic", ["b"]);
		cache.put(source);
		cache.put(target);

		cache.linkEpisodes(source.id, target.id, "continues");

		const related = cache.getRelatedEpisodes(source.id);
		expect(related).toHaveLength(1);
		expect(related[0].item.id).toBe(target.id);
		expect(related[0].relation).toBe("continues");
	});

	test("getRelatedEpisodes returns linked item when queried from the target side", () => {
		const source = createItem("source episode", "episodic", ["a"]);
		const target = createItem("target episode", "episodic", ["b"]);
		cache.put(source);
		cache.put(target);

		cache.linkEpisodes(source.id, target.id, "relates");

		const related = cache.getRelatedEpisodes(target.id);
		expect(related).toHaveLength(1);
		expect(related[0].item.id).toBe(source.id);
		expect(related[0].relation).toBe("relates");
	});

	test("linkEpisodes is idempotent for same triple", () => {
		const a = createItem("episode a", "episodic", []);
		const b = createItem("episode b", "episodic", []);
		cache.put(a);
		cache.put(b);

		cache.linkEpisodes(a.id, b.id, "supersedes");
		cache.linkEpisodes(a.id, b.id, "supersedes"); // duplicate — should be ignored

		const related = cache.getRelatedEpisodes(a.id);
		expect(related).toHaveLength(1);
	});

	test("linkEpisodes allows different relations between the same pair", () => {
		const a = createItem("episode a", "episodic", []);
		const b = createItem("episode b", "episodic", []);
		cache.put(a);
		cache.put(b);

		cache.linkEpisodes(a.id, b.id, "continues");
		cache.linkEpisodes(a.id, b.id, "relates");

		const related = cache.getRelatedEpisodes(a.id);
		expect(related).toHaveLength(2);
		const relations = related.map((r) => r.relation).sort();
		expect(relations).toEqual(["continues", "relates"]);
	});

	test("getRelatedEpisodes returns empty array when no links exist", () => {
		const item = createItem("lonely episode", "episodic", []);
		cache.put(item);

		expect(cache.getRelatedEpisodes(item.id)).toEqual([]);
	});

	test("getRelatedEpisodes omits links whose target item does not exist in cache", () => {
		const source = createItem("source episode", "episodic", []);
		cache.put(source);

		// Link to a non-existent item
		cache.linkEpisodes(source.id, "ghost-id-xyz", "relates");

		const related = cache.getRelatedEpisodes(source.id);
		expect(related).toHaveLength(0);
	});
});

describe("ContextCache eviction ledger", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-evlog-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("records and finds a recent eviction by content hash", () => {
		cache.logEviction("item_1", "hashA", 5);
		const found = cache.findRecentEviction("hashA", 60_000);
		expect(found).not.toBeNull();
		expect(found?.itemId).toBe("item_1");
		expect(found?.evictedTurn).toBe(5);
	});

	test("returns null for an unknown hash", () => {
		cache.logEviction("item_1", "hashA", 5);
		expect(cache.findRecentEviction("hashB", 60_000)).toBeNull();
	});

	test("returns null when the eviction is older than the window", () => {
		cache.logEviction("item_1", "hashA", 5);
		// withinMs = 0 means cutoff is "now"; an entry stamped a moment ago is excluded
		expect(cache.findRecentEviction("hashA", -1)).toBeNull();
	});

	test("clears eviction entries for a hash", () => {
		cache.logEviction("item_1", "hashA", 5);
		cache.clearEvictionForHash("hashA");
		expect(cache.findRecentEviction("hashA", 60_000)).toBeNull();
	});
});

describe("ContextCache memory_links", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-cache-links-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("addLinks + getLinks round-trip", () => {
		const item = createItem("test content", "episodic", ["tag"]);
		cache.put(item);

		cache.addLinks(item.id, [
			{ rel: "file", target: "/src/foo.ts" },
			{ rel: "caused_by", target: "item_abc", label: "triggered by" },
		]);

		const links = cache.getLinks(item.id);
		expect(links).toHaveLength(2);
		expect(links).toEqual(
			expect.arrayContaining([
				{ rel: "file", target: "/src/foo.ts" },
				{ rel: "caused_by", target: "item_abc", label: "triggered by" },
			]),
		);
	});

	test("getLinks returns empty array for unknown item", () => {
		expect(cache.getLinks("nonexistent")).toHaveLength(0);
	});

	test("getBacklinks returns items linking to a target", () => {
		const item1 = createItem("item one", "episodic", []);
		const item2 = createItem("item two", "episodic", []);
		cache.put(item1);
		cache.put(item2);

		cache.addLinks(item1.id, [{ rel: "file", target: "/shared/file.ts" }]);
		cache.addLinks(item2.id, [{ rel: "related", target: "/shared/file.ts", label: "also touches" }]);

		const backlinks = cache.getBacklinks("/shared/file.ts");
		expect(backlinks).toHaveLength(2);
		expect(backlinks.map((b) => b.sourceId)).toEqual(expect.arrayContaining([item1.id, item2.id]));
	});

	test("getBacklinks returns empty array when nothing links to target", () => {
		expect(cache.getBacklinks("/no/such/file.ts")).toHaveLength(0);
	});

	test("links are removed when the source item is deleted (CASCADE)", () => {
		const item = createItem("cascade test", "episodic", []);
		cache.put(item);
		cache.addLinks(item.id, [{ rel: "file", target: "/src/cascade.ts" }]);

		// Enable foreign key enforcement for this connection
		cache.getDb().pragma("foreign_keys = ON");
		cache.delete(item.id);

		expect(cache.getLinks(item.id)).toHaveLength(0);
		expect(cache.getBacklinks("/src/cascade.ts")).toHaveLength(0);
	});

	test("duplicate links are silently ignored", () => {
		const item = createItem("dedup test", "episodic", []);
		cache.put(item);

		cache.addLinks(item.id, [{ rel: "file", target: "/src/x.ts" }]);
		cache.addLinks(item.id, [{ rel: "file", target: "/src/x.ts" }]);

		expect(cache.getLinks(item.id)).toHaveLength(1);
	});
});
