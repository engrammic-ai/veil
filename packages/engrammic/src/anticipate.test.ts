import { describe, expect, test, vi } from "vitest";
import {
	DEFAULT_TRIGGERS,
	buildManifest,
	formatManifest,
	matchTriggers,
} from "./anticipate.ts";
import type { ContextItem, ContextManifest, Trigger } from "./types.ts";

// Minimal mock cache
function makeCache(items: ContextItem[] = []) {
	return {
		getByTags: vi.fn((tags: string[], _limit: number) =>
			items.filter((i) => tags.some((t) => i.tags.includes(t))),
		),
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
		const items = Array.from({ length: 20 }, (_, k) =>
			makeItem({ id: `item-${k}`, tags: ["test"] }),
		);
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
});
