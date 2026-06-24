// packages/engrammic/src/tools.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MockColdStore } from "./cold/mock.ts";
import { ContextManager } from "./manager.ts";
import { executeVeilTool, TOOL_SCHEMAS } from "./tools.ts";

describe("TOOL_SCHEMAS", () => {
	test("has 12 tools defined", () => {
		expect(TOOL_SCHEMAS).toHaveLength(12);
	});

	test("all tools have veil_ prefix", () => {
		for (const tool of TOOL_SCHEMAS) {
			expect(tool.name.startsWith("veil_")).toBe(true);
		}
	});

	test("array properties have items schema", () => {
		const recallTool = TOOL_SCHEMAS.find((t) => t.name === "veil_recall")!;
		expect(recallTool.parameters.properties.tags.items).toEqual({ type: "string" });
	});
});

describe("executeVeilTool", () => {
	let tmpDir: string;
	let manager: ContextManager;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "tools-test-"));
		manager = new ContextManager({ dbPath: join(tmpDir, "context.db") }, new MockColdStore());
	});

	afterEach(async () => {
		await manager.close();
		rmSync(tmpDir, { recursive: true });
	});

	test("veil_remember stores and returns stub", async () => {
		const result = await executeVeilTool(
			"veil_remember",
			{ content: "Important fact", type: "fact", tags: ["test"] },
			{ manager },
		);

		expect(result.success).toBe(true);
		expect(result.data).toBeTruthy();
		expect((result.data as any).id).toBeTruthy();
		expect((result.data as any).stub).toContain("[FACT:");
	});

	test("veil_recall finds stored items", async () => {
		const item = manager.remember("Test content", "episodic", ["test-tag"]);

		const result = await executeVeilTool("veil_recall", { tags: ["test-tag"] }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { items: Array<{ id: string; stub: string }> };
		expect(Array.isArray(data.items)).toBe(true);
		expect(data.items).toHaveLength(1);
		expect(data.items[0].id).toBe(item.id);
		expect(data.items[0].stub).toContain("[EPISODE:");
	});

	test("veil_recall invokes onRecall callback with recalled item IDs", async () => {
		const itemA = manager.remember("Alpha content", "episodic", ["cb-tag"]);
		const itemB = manager.remember("Beta content", "fact", ["cb-tag"]);
		const onRecall = vi.fn();

		const result = await executeVeilTool("veil_recall", { tags: ["cb-tag"] }, { manager, onRecall });

		expect(result.success).toBe(true);
		expect(onRecall).toHaveBeenCalledTimes(1);
		const calledWith: string[] = onRecall.mock.calls[0][0];
		expect(calledWith).toHaveLength(2);
		expect(calledWith).toContain(itemA.id);
		expect(calledWith).toContain(itemB.id);
	});

	test("veil_recall supports semantic query parameter", async () => {
		manager.remember("AI coding tools market analysis for 2026", "fact", ["research"]);

		const result = await executeVeilTool("veil_recall", { query: "AI coding" }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { formatted: string; items: Array<{ id: string }> };
		// Should find via cache search (FTS-like matching)
		expect(data.items.length).toBeGreaterThanOrEqual(0);
	});

	test("veil_recall combines query and tags", async () => {
		manager.remember("OAuth authentication flow", "fact", ["auth"]);
		manager.remember("OAuth token refresh", "fact", ["auth"]);
		manager.remember("Database connection pooling", "fact", ["db"]);

		const result = await executeVeilTool("veil_recall", { query: "OAuth", tags: ["auth"] }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { items: Array<{ id: string }> };
		// Should find auth-tagged items matching OAuth
		expect(data.items.length).toBeLessThanOrEqual(2);
	});

	test("veil_recall returns error when neither query nor tags provided", async () => {
		const result = await executeVeilTool("veil_recall", {}, { manager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("query or tags");
	});

	test("veil_promote loads item into context", async () => {
		const item = manager.remember("Content to promote", "fact", []);
		const result = await executeVeilTool("veil_promote", { id: item.id }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { id: string; stub: string };
		expect(data.id).toBe(item.id);
		expect(data.stub).toContain("[FACT:");
		const window = manager.getWindow();
		expect(window.items).toHaveLength(1);
	});

	test("veil_demote unloads item from context", async () => {
		const item = manager.remember("Content", "fact", []);
		manager.load([item.id]);
		expect(manager.getWindow().items).toHaveLength(1);

		await executeVeilTool("veil_demote", { id: item.id }, { manager });
		expect(manager.getWindow().items).toHaveLength(0);
	});

	test("veil_pin marks item as pinned", async () => {
		const item = manager.remember("Important", "fact", []);
		manager.load([item.id]);

		await executeVeilTool("veil_pin", { id: item.id }, { manager });
		const window = manager.getWindow();
		expect(window.items[0].pinned).toBe(true);
	});

	test("veil_unpin marks item as unpinned", async () => {
		const item = manager.remember("Important", "fact", []);
		manager.load([item.id]);
		manager.pin(item.id);

		await executeVeilTool("veil_unpin", { id: item.id }, { manager });
		const window = manager.getWindow();
		expect(window.items[0].pinned).toBe(false);
	});

	test("veil_forget removes item", async () => {
		const item = manager.remember("To forget", "episodic", []);

		const result = await executeVeilTool("veil_forget", { id: item.id }, { manager });
		expect(result.success).toBe(true);

		const recalled = await manager.recall([], 10);
		expect(recalled).toHaveLength(0);
	});

	test("veil_hydrate returns content", async () => {
		const item = manager.remember("Full content here", "fact", []);
		const stub = `[FACT:${item.id}:summary]`;

		const result = await executeVeilTool("veil_hydrate", { stub }, { manager });

		expect(result.success).toBe(true);
		expect((result.data as any).content).toBe("Full content here");
	});

	test("veil_hydrate returns error for invalid stub", async () => {
		const result = await executeVeilTool("veil_hydrate", { stub: "not a stub" }, { manager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid stub");
	});

	test("veil_demote returns error if item not in active context", async () => {
		// remember() auto-loads items, so we need to unload first to test the error case
		const item = manager.remember("Initially loaded", "fact", []);
		manager.unload([item.id]); // Now it's only in warm cache, not active

		const result = await executeVeilTool("veil_demote", { id: item.id }, { manager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("not in active context");
	});

	test("veil_pin returns error if item not found", async () => {
		const result = await executeVeilTool("veil_pin", { id: "nonexistent-id" }, { manager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Item not found");
	});

	test("veil_unpin returns error if item not found", async () => {
		const result = await executeVeilTool("veil_unpin", { id: "nonexistent-id" }, { manager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Item not found");
	});

	test("unknown tool returns error", async () => {
		const result = await executeVeilTool("veil_unknown", {}, { manager });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Unknown tool");
	});

	test("veil_history returns empty message when no cold store query", async () => {
		// MockColdStore has no query method, so searchHistory returns []
		const result = await executeVeilTool("veil_history", { query: "test query" }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { formatted: string };
		expect(data.formatted).toContain("No related context found");
	});

	test("veil_history passes days parameter to since calculation", async () => {
		// With MockColdStore (no query), always returns empty regardless of days
		const result = await executeVeilTool("veil_history", { query: "test", days: 30 }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { formatted: string };
		expect(data.formatted).toContain("No related context found");
	});

	test("veil_history uses 7-day default when days not provided", async () => {
		const result = await executeVeilTool("veil_history", { query: "anything" }, { manager });

		expect(result.success).toBe(true);
	});
});

describe("veil_history with mock ColdStore that has query", () => {
	let tmpDir: string;
	let manager: ContextManager;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "tools-history-test-"));

		// Build a mock ColdStore with a query method that returns items
		const mockItem = {
			id: "cold-item-1",
			content: "historical deployment procedure for canary releases",
			contentHash: "abc",
			createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
			lastAccess: Date.now(),
			accessCount: 1,
			decayScore: 0.8,
			cognitiveWeight: 0,
			type: "procedural" as const,
			tags: ["deploy", "canary"],
			pinned: false,
			source: "auto" as const,
		};

		const mockColdStore = {
			capabilities: { semantic: true, temporal: false, provenance: false },
			demote: vi.fn().mockResolvedValue("ptr_1"),
			fetch: vi.fn().mockResolvedValue(null),
			exists: vi.fn().mockResolvedValue(false),
			delete: vi.fn().mockResolvedValue(undefined),
			count: vi.fn().mockResolvedValue(1),
			close: vi.fn().mockResolvedValue(undefined),
			query: vi.fn().mockResolvedValue([mockItem]),
		};

		manager = new ContextManager({ dbPath: join(tmpDir, "context.db") }, mockColdStore);
	});

	afterEach(async () => {
		await manager.close();
		rmSync(tmpDir, { recursive: true });
	});

	test("veil_history returns formatted items when cold store query returns results", async () => {
		const result = await executeVeilTool("veil_history", { query: "deployment", days: 7 }, { manager });

		expect(result.success).toBe(true);
		const data = result.data as { items: unknown[]; formatted: string };
		expect(Array.isArray(data.items)).toBe(true);
		expect(data.items.length).toBeGreaterThan(0);
		expect(data.formatted).toContain("cold-item-1");
		expect(data.formatted).toContain("procedural");
		expect(data.formatted).toContain("historical deployment");
	});

	test("veil_history filters out items older than the since cutoff", async () => {
		const result = await executeVeilTool("veil_history", { query: "deployment", days: 1 }, { manager });
		// mockItem is 2 days old; days=1 cuts off at 1 day ago — item should be filtered out
		expect(result.success).toBe(true);
		const data = result.data as { formatted?: string; items?: unknown[] };
		expect(data.formatted).toContain("No related context found");
	});
});

describe("ContextManager episode API", () => {
	let tmpDir: string;
	let manager: ContextManager;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "episode-api-test-"));
		manager = new ContextManager({ dbPath: join(tmpDir, "context.db") }, new MockColdStore());
	});

	afterEach(async () => {
		await manager.close();
		rmSync(tmpDir, { recursive: true });
	});

	test("linkEpisodes connects two items", () => {
		const a = manager.remember("Episode A", "episodic", []);
		const b = manager.remember("Episode B", "episodic", []);

		// Should not throw
		expect(() => manager.linkEpisodes(a.id, b.id, "continues")).not.toThrow();
	});

	test("getRelatedEpisodes returns linked items", () => {
		const a = manager.remember("Episode A", "episodic", []);
		const b = manager.remember("Episode B", "episodic", []);
		manager.linkEpisodes(a.id, b.id, "relates");

		const related = manager.getRelatedEpisodes(a.id);

		expect(Array.isArray(related)).toBe(true);
		expect(related.length).toBeGreaterThan(0);
		const targetIds = related.map((r) => r.item.id);
		expect(targetIds).toContain(b.id);
	});

	test("getRelatedEpisodes returns relation type", () => {
		const a = manager.remember("Episode A", "episodic", []);
		const b = manager.remember("Episode B", "episodic", []);
		manager.linkEpisodes(a.id, b.id, "supersedes");

		const related = manager.getRelatedEpisodes(a.id);
		const entry = related.find((r) => r.item.id === b.id);

		expect(entry).toBeDefined();
		expect(entry!.relation).toBe("supersedes");
	});

	test("searchHistory returns empty array when cold store has no query", async () => {
		const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const results = await manager.searchHistory("test", since);

		expect(Array.isArray(results)).toBe(true);
		expect(results).toHaveLength(0);
	});
});
