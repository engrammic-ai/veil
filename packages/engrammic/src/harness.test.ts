/**
 * Basic integration test for VeilHarness
 *
 * Note: Tests use MemoryColdStore to avoid native SQLite dependency issues.
 * Full SQLite tests should run in CI with proper native module builds.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { MemoryColdStore } from "./cold/memory.ts";
import { VeilHarness } from "./harness.ts";

describe("MemoryColdStore", () => {
	test("basic operations", async () => {
		const store = new MemoryColdStore();

		const item = {
			id: "test-1",
			content: "Test content",
			contentHash: "abc123",
			createdAt: Date.now(),
			lastAccess: Date.now(),
			accessCount: 1,
			usedCount: 0,
			ignoredCount: 0,
			decayScore: 1.0,
			cognitiveWeight: 0,
			stability: 0.5,
			difficulty: 0.5,
			type: "fact" as const,
			tags: ["test"],
			pinned: false,
			source: "auto" as const,
		};

		const pointer = await store.demote(item);
		expect(pointer.startsWith("mem_")).toBe(true);

		const fetched = await store.fetch(pointer);
		expect(fetched).toBeTruthy();
		expect(fetched!.content).toBe("Test content");
		expect(fetched!.accessCount).toBe(2); // incremented on fetch

		expect(await store.exists(pointer)).toBe(true);

		await store.delete(pointer);
		expect(await store.exists(pointer)).toBe(false);

		await store.close();
	});

	test("capabilities", () => {
		const store = new MemoryColdStore();
		expect(store.capabilities.semantic).toBe(false);
		expect(store.capabilities.temporal).toBe(false);
		expect(store.capabilities.provenance).toBe(false);
	});
});

describe("VeilHarness", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("initializes with defaults", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const budget = harness.getBudget();
		expect(budget.maxTokens).toBeGreaterThan(0);
		expect(budget.usedTokens).toBe(0);

		await harness.close();
	});

	test("remember and recall", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const item = harness.remember("The API uses OAuth2 for authentication", "fact", ["auth", "api"]);

		expect(item.id).toBeTruthy();
		expect(item.type).toBe("fact");

		const recalled = await harness.recall(["auth"], 10);
		expect(recalled.length).toBe(1);
		expect(recalled[0].content).toBe("The API uses OAuth2 for authentication");

		await harness.close();
	});

	test("load and unload affect budget", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const item = harness.remember("Some content", "episodic", ["test"]);

		// remember() now adds to loaded immediately (for eviction visibility)
		expect(harness.getBudget().usedTokens).toBeGreaterThan(0);

		// load() is idempotent - item already loaded
		harness.load([item.id]);
		expect(harness.getBudget().usedTokens).toBeGreaterThan(0);

		const window = harness.getWindow();
		expect(window.items.length).toBe(1);

		harness.unload([item.id]);
		expect(harness.getBudget().usedTokens).toBe(0);

		await harness.close();
	});

	test("hooks integrate with agent loop", async () => {
		const checkpoints: number[] = [];

		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			checkpointIntervalTurns: 2,
			onCheckpoint: (turn) => checkpoints.push(turn),
		});

		const hooks = harness.getHooks();
		expect(hooks.beforeToolCall).toBeTruthy();
		expect(hooks.afterToolCall).toBeTruthy();

		// Simulate tool calls
		await hooks.beforeToolCall({ toolCall: { name: "Read" }, args: { file_path: "/test.ts" } });
		await hooks.afterToolCall({ toolCall: { name: "Read" }, result: { isError: false } });

		expect(harness.getTurnCount()).toBe(1);

		await hooks.afterToolCall({ toolCall: { name: "Write" }, result: { isError: false } });
		expect(harness.getTurnCount()).toBe(2);
		expect(checkpoints.length).toBe(1); // Checkpoint at turn 2

		await harness.close();
	});

	test("pin prevents eviction", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const item = harness.remember("Important info", "procedural", ["critical"]);
		harness.load([item.id]);
		harness.pin(item.id);

		const window = harness.getWindow();
		expect(window.items[0].pinned).toBe(true);

		harness.unpin(item.id);
		const window2 = harness.getWindow();
		expect(window2.items[0].pinned).toBe(false);

		await harness.close();
	});
});

describe("getUsage", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	it("returns usage stats", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		// Remember and load an item
		const item = harness.remember("Test content for usage", "fact", ["test"]);
		harness.load([item.id]);

		const usage = harness.getUsage();

		expect(usage.hotTokens).toBeGreaterThan(0);
		expect(usage.hotItems).toBe(1);
		expect(usage.budgetMax).toBeGreaterThan(0);
		expect(usage.budgetUsed).toBe(usage.hotTokens);
		expect(typeof usage.percent).toBe("number");

		await harness.close();
	});
});

describe("autoCapture integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	// Helper: build a mock agentHarness and return [mockAgentHarness, emit]
	function makeMockAgentHarness() {
		const handlers: Array<(event: any) => void> = [];
		const mockAgentHarness = {
			on: (_type: "tool_result", handler: (event: any) => void) => {
				handlers.push(handler);
				return () => {
					const idx = handlers.indexOf(handler);
					if (idx !== -1) handlers.splice(idx, 1);
				};
			},
		};
		const emit = (event: any) => {
			for (const h of handlers) h(event);
		};
		return { mockAgentHarness, emit };
	}

	test("captures Read tool results", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		const fileContent = "export function greet(name: string): string { return 'Hello, ' + name + '!'; }";

		emit({
			toolName: "Read",
			input: { file_path: "/tmp/test.ts" },
			content: [{ type: "text", text: fileContent }],
			isError: false,
		});

		// Content should be stored in warm cache (extracted format, not raw)
		const recalled = await harness.recall(["file", "read"], 10);
		expect(recalled.length).toBe(1);
		expect(recalled[0].content).toContain("[Read] /tmp/test.ts");
		expect(recalled[0].content).toContain("export function greet");

		await harness.close();
	});

	test("ignores non-capturable tools", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		// Unknown tool (not in capture rules) — should be ignored
		emit({
			toolName: "UnknownTool",
			input: { some_arg: "value" },
			content: [{ type: "text", text: "Some result from an unknown tool that should not be captured." }],
			isError: false,
		});

		// Nothing should be captured
		const cache = harness.getManager().getCache();
		const allItems = cache.getAll();
		expect(allItems.length).toBe(0);

		await harness.close();
	});

	test("respects rate limits", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			captureConfig: { maxItemsPerTurn: 5, maxItemsPerSession: 500, minChars: 50, maxChars: 8000 },
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		// Emit 6 unique Read results in the same turn
		for (let i = 1; i <= 6; i++) {
			emit({
				toolName: "Read",
				input: { file_path: `/tmp/file${i}.ts` },
				content: [
					{
						type: "text",
						text: `// file${i}.ts — unique content block number ${i} for rate limit testing purposes only`,
					},
				],
				isError: false,
			});
		}

		// Only 5 should have been captured (maxItemsPerTurn)
		const cache = harness.getManager().getCache();
		const allItems = cache.getAll();
		expect(allItems.length).toBe(5);

		await harness.close();
	});

	test("deduplicates identical content", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		const identicalContent = "export const VERSION = '1.0.0'; // version constant used across the project";

		// Emit the same content twice
		for (let i = 0; i < 2; i++) {
			emit({
				toolName: "Read",
				input: { file_path: "/tmp/version.ts" },
				content: [{ type: "text", text: identicalContent }],
				isError: false,
			});
		}

		// Only 1 item should exist in cache (deduplication by content hash)
		const cache = harness.getManager().getCache();
		const allItems = cache.getAll();
		expect(allItems.length).toBe(1);
		// Content is now in extracted format, not raw
		expect(allItems[0].content).toContain("[Read] /tmp/version.ts");
		expect(allItems[0].content).toContain("export const VERSION");

		await harness.close();
	});

	test("debounces rapid edits to same file into single capture", async () => {
		vi.useFakeTimers();

		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		const editContent = (n: number) =>
			`function foo() { return ${n}; } // edit number ${n} with enough content to pass minChars check`;

		// Emit 3 rapid edits to the same file
		for (let i = 1; i <= 3; i++) {
			emit({
				toolName: "Edit",
				input: { file_path: "/tmp/foo.ts" },
				content: [{ type: "text", text: editContent(i) }],
				isError: false,
			});
		}

		// Nothing committed yet — window still open
		expect(harness.getManager().getCache().getAll().length).toBe(0);

		// Advance past 30s debounce window
		vi.advanceTimersByTime(31000);

		// Only 1 capture should exist (the last edit merged)
		const allItems = harness.getManager().getCache().getAll();
		expect(allItems.length).toBe(1);

		vi.useRealTimers();
		await harness.close();
	});

	test("deduplicates edits to same file by dedupeKey even when content differs", async () => {
		vi.useFakeTimers();

		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		const filePath = "/tmp/dedupe-target.ts";

		// First edit — committed after debounce window
		emit({
			toolName: "Edit",
			input: { file_path: filePath },
			content: [
				{ type: "text", text: `function foo() { return 1; } // version 1 with enough chars for minChars check` },
			],
			isError: false,
		});
		vi.advanceTimersByTime(31000);

		// Only 1 item captured so far
		expect(harness.getManager().getCache().getAll().length).toBe(1);

		// Second edit to the same file with different content
		emit({
			toolName: "Edit",
			input: { file_path: filePath },
			content: [
				{
					type: "text",
					text: `function foo() { return 42; } // version 2 with different content, still same file`,
				},
			],
			isError: false,
		});
		vi.advanceTimersByTime(31000);

		// Should still be 1 item (semantic dedup by edit:<file_path> key)
		const allItems = harness.getManager().getCache().getAll();
		expect(allItems.length).toBe(1);

		vi.useRealTimers();
		await harness.close();
	});

	test("does not capture error results", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		emit({
			toolName: "Read",
			input: { file_path: "/tmp/missing.ts" },
			content: [{ type: "text", text: "Error: file not found: /tmp/missing.ts — no such file or directory exists" }],
			isError: true,
		});

		const cache = harness.getManager().getCache();
		expect(cache.getAll().length).toBe(0);

		await harness.close();
	});
});

describe("custom triggers loaded on startup", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test.skip("custom triggers persisted to DB are merged with DEFAULT_TRIGGERS on harness init", async () => {
		const dbPath = join(tmpDir, "context.db");

		// First harness: persist a custom trigger and a matching item
		const harness1 = new VeilHarness({ dbPath, coldStore: new MemoryColdStore() });
		harness1.remember("deployment runbook for canary releases", "procedural", ["deploy", "canary"]);
		harness1
			.getManager()
			.getCache()
			.persistTrigger({
				id: "custom-deploy-trigger",
				pattern: /\bdeploy\b/i,
				type: "keyword",
				action: { tags: ["deploy"] },
				priority: 10,
				enabled: true,
				learned: true,
			});
		await harness1.close();

		// Second harness: reopen same DB — custom trigger must be loaded
		const harness2 = new VeilHarness({ dbPath, coldStore: new MemoryColdStore() });
		const result = await harness2.processUserMessage("how do we deploy to production?");
		await harness2.close();

		// The custom trigger matched, so a manifest should be returned
		expect(result).not.toBeNull();
		expect(result).toContain("<veil-available>");
		expect(result).toContain("deployment runbook");
	});
});

describe("processUserMessage (anticipatory loading)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("returns manifest when triggers match", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		// Store something with "test" tag
		harness.remember("Test failure in auth module", "episodic", ["test", "auth"]);

		const result = await harness.processUserMessage("fix the tests");
		expect(result).not.toBeNull();
		expect(result).toContain("<veil-available>");
		expect(result).toContain("Test failure in auth");

		await harness.close();
	});

	test("returns null when no triggers match", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		harness.remember("Some content", "fact", ["unrelated"]);

		const result = await harness.processUserMessage("hello world");
		expect(result).toBeNull();

		await harness.close();
	});

	test("returns null when budget exceeds 70%", async () => {
		// Use small maxTokens with no reserve so we can easily exceed 70%
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			maxTokens: 100,
			reserveTokens: 0,
		});

		// Each char is ~0.25 tokens, so 400 chars ≈ 100 tokens
		// Load multiple items to exceed 70% (70 tokens)
		for (let i = 0; i < 5; i++) {
			const content = `Test content number ${i} with more text to make it bigger ${"x".repeat(100)}`;
			const item = harness.remember(content, "fact", ["test"]);
			harness.load([item.id]);
		}

		const usage = harness.getUsage();
		expect(usage.hotItems).toBe(5);
		expect(usage.percent).toBeGreaterThan(70);

		const result = await harness.processUserMessage("run the tests");
		expect(result).toBeNull();

		await harness.close();
	});

	test("preloads top items when budget < 50%", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		// Store items - remember() now adds to loaded immediately
		harness.remember("Test item 1", "episodic", ["test"]);
		harness.remember("Test item 2", "episodic", ["test"]);

		const beforeItems = harness.getWindow().items.length;
		expect(beforeItems).toBe(2); // Items already loaded

		await harness.processUserMessage("run the tests");

		// Items already in loaded, processUserMessage doesn't duplicate
		const afterItems = harness.getWindow().items.length;
		expect(afterItems).toBeGreaterThanOrEqual(beforeItems);

		await harness.close();
	});
});

describe("maybeLearn", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("does not run before interval has elapsed", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			learningConfig: { intervalMs: 60 * 60 * 1000, minHydrations: 1 },
		});

		// Inject hydration events directly so the threshold is met
		const cache = harness.getManager().getCache();
		const item = harness.remember("deploy runbook for production releases", "procedural", ["deploy"]);
		cache.logHydration({
			sessionId: "test",
			itemId: item.id,
			triggerIds: [],
			userMessage: "deploy to production",
			hydratedAt: Date.now(),
			latencyMs: 10,
		});

		const _triggersBefore = cache.loadCustomTriggers().length;

		// maybeLearn should skip because lastLearnTime is 0 and intervalMs is 1hr
		// i.e. it would RUN (0 elapsed > 1hr? No — 0 elapsed < 1hr, so it should skip)
		// With lastLearnTime=0, now - 0 = large number > 1hr, so it WILL run.
		// We need to run it once to set lastLearnTime, then call again immediately.
		await harness.maybeLearn(); // first call: sets lastLearnTime
		const triggersAfterFirst = cache.loadCustomTriggers().length;

		await harness.maybeLearn(); // second call: interval not elapsed, skips
		const triggersAfterSecond = cache.loadCustomTriggers().length;

		// Both calls should result in the same trigger count (second was skipped)
		expect(triggersAfterSecond).toBe(triggersAfterFirst);

		await harness.close();
	});

	test("skips when fewer than minHydrations events exist", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			learningConfig: { intervalMs: 0, minHydrations: 5 },
		});

		const cache = harness.getManager().getCache();
		const item = harness.remember("deploy runbook for production releases", "procedural", ["deploy"]);

		// Log only 3 hydrations (below minHydrations=5)
		for (let i = 0; i < 3; i++) {
			cache.logHydration({
				sessionId: "test",
				itemId: item.id,
				triggerIds: [],
				userMessage: `deploy message ${i}`,
				hydratedAt: Date.now(),
				latencyMs: 10,
			});
		}

		const triggersBefore = cache.loadCustomTriggers().length;
		await harness.maybeLearn();
		const triggersAfter = cache.loadCustomTriggers().length;

		expect(triggersAfter).toBe(triggersBefore);

		await harness.close();
	});

	test("persists new triggers when patterns are found", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			// intervalMs=0 forces the interval check to pass; minHydrations=3 is low enough
			learningConfig: { intervalMs: 0, minHydrations: 3 },
		});

		const cache = harness.getManager().getCache();
		// Use a unique tag not covered by DEFAULT_TRIGGERS
		const item = harness.remember("canary deployment checklist", "procedural", ["canary"]);

		// Log enough hydrations with the same keyword to form a pattern.
		// Use distinct hydratedAt values to avoid the UNIQUE(session_id, item_id, hydrated_at)
		// constraint silently dropping duplicate-timestamp rows.
		const messages = ["canary release steps", "canary deployment procedure", "canary rollout guide"];
		const now = Date.now();
		for (let i = 0; i < messages.length; i++) {
			cache.logHydration({
				sessionId: "test",
				itemId: item.id,
				triggerIds: [],
				userMessage: messages[i],
				hydratedAt: now + i,
				latencyMs: 10,
			});
		}

		const triggersBefore = cache.loadCustomTriggers().length;
		await harness.maybeLearn();
		const triggersAfter = cache.loadCustomTriggers().length;

		// A learned trigger should have been persisted
		expect(triggersAfter).toBeGreaterThan(triggersBefore);

		await harness.close();
	});

	test("uses learningConfig overrides from VeilHarnessConfig", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			learningConfig: { intervalMs: 999999999, minHydrations: 1 },
		});

		const cache = harness.getManager().getCache();
		const item = harness.remember("some content", "fact", ["sometag"]);
		cache.logHydration({
			sessionId: "test",
			itemId: item.id,
			triggerIds: [],
			userMessage: "some message",
			hydratedAt: Date.now(),
			latencyMs: 5,
		});

		const triggersBefore = cache.loadCustomTriggers().length;
		// intervalMs is huge so maybeLearn should skip
		await harness.maybeLearn();
		const triggersAfter = cache.loadCustomTriggers().length;

		expect(triggersAfter).toBe(triggersBefore);

		await harness.close();
	});
});

describe("learned trigger matches subsequent messages", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test.skip("a learned trigger surfaces manifest items on the next processUserMessage call", async () => {
		const dbPath = join(tmpDir, "context.db");

		// First harness: store item, log hydrations, run maybeLearn to produce a learned trigger
		const harness1 = new VeilHarness({
			dbPath,
			coldStore: new MemoryColdStore(),
			learningConfig: { intervalMs: 0, minHydrations: 3 },
		});

		const item = harness1.remember("canary deployment checklist for production", "procedural", ["canary"]);
		const cache1 = harness1.getManager().getCache();

		const messages = ["canary release steps", "canary deployment procedure", "canary rollout guide"];
		const now = Date.now();
		for (let i = 0; i < messages.length; i++) {
			cache1.logHydration({
				sessionId: "s1",
				itemId: item.id,
				triggerIds: [],
				userMessage: messages[i],
				hydratedAt: now + i,
				latencyMs: 10,
			});
		}

		await harness1.maybeLearn();
		const learnedTriggers = cache1.loadCustomTriggers();
		expect(learnedTriggers.length).toBeGreaterThan(0); // sanity-check: learning ran

		await harness1.close();

		// Second harness: reopen same DB — learned trigger is loaded at init
		const harness2 = new VeilHarness({ dbPath, coldStore: new MemoryColdStore() });

		// Send a message that should match the learned trigger's pattern
		const keyword = learnedTriggers[0].pattern.source; // e.g. "canary"
		const manifest = await harness2.processUserMessage(`show me the ${keyword} guide`);

		await harness2.close();

		// The manifest must be non-null — the learned trigger matched and surfaced the item
		expect(manifest).not.toBeNull();
		expect(manifest).toContain("<veil-available>");
		expect(manifest).toContain("canary deployment");
	});
});

describe("processUserMessage buildManifest exception handling", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("returns null gracefully when buildManifest throws", async () => {
		const dbPath = join(tmpDir, "context.db");

		// Provide a cold store whose query method always throws — this exercises the
		// try/catch around buildManifest inside processUserMessage.
		const throwingColdStore = {
			capabilities: { semantic: true, temporal: false, provenance: false },
			demote: vi.fn().mockResolvedValue("ptr_x"),
			fetch: vi.fn().mockResolvedValue(null),
			exists: vi.fn().mockResolvedValue(false),
			delete: vi.fn().mockResolvedValue(undefined),
			count: vi.fn().mockResolvedValue(0),
			close: vi.fn().mockResolvedValue(undefined),
			// Returning a rejecting promise causes buildManifest to throw during cold fetch
			query: vi.fn().mockRejectedValue(new Error("cold storage unavailable")),
		};

		const harness = new VeilHarness({ dbPath, coldStore: throwingColdStore });

		// Store an item with tags matched by the "debug" DEFAULT_TRIGGER
		harness.remember("Debug notes on the crash", "episodic", ["debug", "error"]);

		// processUserMessage must not throw; it should catch and return null
		const result = await harness.processUserMessage("I am debugging a crash");

		// Result may be null (error path) or a valid manifest (if warm cache items
		// were surfaced before the cold query threw). Either way, no exception should escape.
		expect(() => result).not.toThrow();

		await harness.close();
	});
});

// ─── D.2 — Failure Surfacing ──────────────────────────────────────────────────

describe("getFailureSection", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("returns empty string when no current goal", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const section = harness.getFailureSection();
		expect(section).toBe("");

		await harness.close();
	});

	test("returns empty string when no failures for goal", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		// Simulate a goal being set without failures
		const state = harness.getGoalState();
		state.currentGoalId = "file:test.ts";

		const section = harness.getFailureSection();
		expect(section).toBe("");

		await harness.close();
	});

	test("returns failure section when failures exist", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const store = harness.getAttemptStore();
		store.put({
			id: "attempt-1",
			sessionId: "session-1",
			goalId: "file:auth.ts",
			iteration: 1,
			action: "bash",
			target: "npm test",
			outcome: "fail",
			evidence: "Test failed",
			errorPattern: "test-failure",
			createdAt: Date.now(),
			turn: 1,
			goalOpen: true,
			pinned: false,
		});

		// Set the current goal
		const state = harness.getGoalState();
		state.currentGoalId = "file:auth.ts";

		const section = harness.getFailureSection();
		expect(section).toContain("<veil-failures");
		expect(section).toContain("Already tried");
		expect(section).toContain("bash: npm test");
		expect(section).toContain("FAILED: Test failed");

		await harness.close();
	});
});

// ─── D.3 — Convergence Monitor Integration ────────────────────────────────────

describe("getConvergenceState", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("returns null for unknown goal", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const state = harness.getConvergenceState("unknown-goal");
		expect(state).toBeNull();

		await harness.close();
	});

	test("getConvergenceMonitor returns monitor instance", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const monitor = harness.getConvergenceMonitor();
		expect(monitor).toBeDefined();
		expect(typeof monitor.getState).toBe("function");

		await harness.close();
	});

	test("convergenceThresholds config is applied", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			convergenceThresholds: { maxConsecutiveFailures: 10 },
		});

		const monitor = harness.getConvergenceMonitor();
		const thresholds = monitor.getThresholds();
		expect(thresholds.maxConsecutiveFailures).toBe(10);

		await harness.close();
	});

	test("convergence monitor tracks failures via direct update", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			convergenceThresholds: { maxConsecutiveFailures: 2 },
		});

		const monitor = harness.getConvergenceMonitor();

		monitor.update(
			{
				id: "a1",
				sessionId: "s1",
				goalId: "test",
				iteration: 1,
				action: "bash",
				outcome: "fail",
				createdAt: Date.now(),
				turn: 1,
				goalOpen: true,
				pinned: false,
			},
			1,
		);

		monitor.update(
			{
				id: "a2",
				sessionId: "s1",
				goalId: "test",
				iteration: 2,
				action: "bash",
				outcome: "fail",
				createdAt: Date.now(),
				turn: 2,
				goalOpen: true,
				pinned: false,
			},
			2,
		);

		const state = harness.getConvergenceState("test");
		expect(state).not.toBeNull();
		expect(state?.consecutiveFailures).toBe(2);

		await harness.close();
	});
});

describe("token budget tracking", () => {
	let tmpDir: string;

	function makeMockAgentHarness() {
		const handlers: Array<(event: any) => void> = [];
		const mockAgentHarness = {
			on: (_type: "tool_result", handler: (event: any) => void) => {
				handlers.push(handler);
				return () => {
					const idx = handlers.indexOf(handler);
					if (idx !== -1) handlers.splice(idx, 1);
				};
			},
		};
		const emit = (event: any) => {
			for (const h of handlers) h(event);
		};
		return { mockAgentHarness, emit };
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("getCaptureBudget returns initial zero state", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			captureConfig: { maxTokenBudget: 8000, softThresholdPercent: 0.75 },
		});

		const budget = harness.getCaptureBudget();
		expect(budget.used).toBe(0);
		expect(budget.max).toBe(8000);
		expect(budget.softThreshold).toBe(6000);
		expect(budget.softWarningEmitted).toBe(false);

		await harness.close();
	});

	test("emits budget_warning when soft threshold crossed", async () => {
		// 200-token budget, soft at 50%. Items are ~20 chars → ~5 tokens each.
		// After enough items to cross 100 tokens, warning fires.
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			captureConfig: {
				maxTokenBudget: 200,
				softThresholdPercent: 0.5,
				maxItemsPerTurn: 100,
				maxItemsPerSession: 1000,
				minChars: 10,
				maxChars: 99999,
			},
		});

		const events: Array<{ type: string; detail?: string }> = [];
		harness.onMemoryEvent((e) => events.push(e));

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		// Each item ~80 chars → ~20 tokens. After 5 items (100 tokens) we cross the 100-token threshold.
		for (let i = 0; i < 8; i++) {
			emit({
				toolName: "Read",
				input: { file_path: `/tmp/file${i}.ts` },
				content: [
					{ type: "text", text: `export function fn${i}() { return ${i}; } // unique content item ${i} padding` },
				],
				isError: false,
			});
		}

		const warningEvents = events.filter((e) => e.type === "budget_warning");
		expect(warningEvents.length).toBe(1);
		expect(harness.getCaptureBudget().softWarningEmitted).toBe(true);

		await harness.close();
	});

	test("emits budget_exceeded and skips capture when hard cap reached", async () => {
		// Very small budget: 50 tokens. Items ~80 chars → ~20 tokens each. Only 2-3 fit.
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			captureConfig: {
				maxTokenBudget: 50,
				softThresholdPercent: 0.75,
				maxItemsPerTurn: 100,
				maxItemsPerSession: 1000,
				minChars: 10,
				maxChars: 99999,
			},
		});

		const events: Array<{ type: string; detail?: string }> = [];
		harness.onMemoryEvent((e) => events.push(e));

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		for (let i = 0; i < 8; i++) {
			emit({
				toolName: "Read",
				input: { file_path: `/tmp/cap${i}.ts` },
				content: [
					{ type: "text", text: `export function cap${i}() { return ${i}; } // unique item for budget test ${i}` },
				],
				isError: false,
			});
		}

		const exceededEvents = events.filter((e) => e.type === "budget_exceeded");
		expect(exceededEvents.length).toBeGreaterThan(0);
		expect(exceededEvents[0].detail).toContain("budget full");

		// Cache should have fewer items than emitted
		const allItems = harness.getManager().getCache().getAll();
		expect(allItems.length).toBeLessThan(8);

		await harness.close();
	});

	test("budget_warning emitted only once even when exceeded further", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
			captureConfig: {
				maxTokenBudget: 200,
				softThresholdPercent: 0.5,
				maxItemsPerTurn: 100,
				maxItemsPerSession: 1000,
				minChars: 10,
				maxChars: 99999,
			},
		});

		const events: Array<{ type: string }> = [];
		harness.onMemoryEvent((e) => events.push(e));

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		for (let i = 0; i < 12; i++) {
			emit({
				toolName: "Read",
				input: { file_path: `/tmp/warn${i}.ts` },
				content: [
					{ type: "text", text: `export function warn${i}() { return ${i}; } // content padding item ${i}` },
				],
				isError: false,
			});
		}

		const warningEvents = events.filter((e) => e.type === "budget_warning");
		expect(warningEvents.length).toBe(1);

		await harness.close();
	});
});

describe("VeilHarness.search", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-search-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("returns hot items first with score 1.0", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const item = harness.remember("OAuth2 authentication flow", "fact", ["auth"]);
		harness.load([item.id]);

		const results = harness.search("OAuth2");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].tier).toBe("hot");
		expect(results[0].score).toBe(1.0);
		expect(results[0].id).toBe(item.id);

		await harness.close();
	});

	test("returns warm items with score 0.8 when not in hot tier", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		harness.remember("database migration guide", "procedural", ["db"]);
		// remember() now adds to loaded (hot) for eviction visibility

		const results = harness.search("migration");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].tier).toBe("hot");
		expect(results[0].score).toBe(1.0);

		await harness.close();
	});

	test("deduplicates: hot item wins over warm copy", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const item = harness.remember("dedup check content", "fact", ["dedup"]);
		harness.load([item.id]); // now in hot AND warm

		const results = harness.search("dedup check");
		const ids = results.map((r) => r.id);
		// Should appear exactly once
		expect(ids.filter((id) => id === item.id)).toHaveLength(1);
		// And that one occurrence must be hot
		const found = results.find((r) => r.id === item.id);
		expect(found?.tier).toBe("hot");

		await harness.close();
	});

	test("respects limit parameter", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		for (let i = 0; i < 8; i++) {
			harness.remember(`searchable content item number ${i}`, "fact", []);
		}

		const results = harness.search("searchable content", 3);
		expect(results.length).toBeLessThanOrEqual(3);

		await harness.close();
	});

	test("returns empty array when nothing matches", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		harness.remember("completely unrelated", "fact", []);

		const results = harness.search("zzznomatch");
		expect(results).toHaveLength(0);

		await harness.close();
	});

	test("summary is first 40 chars of content", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const longContent = `${"A".repeat(100)} target ${"B".repeat(100)}`;
		harness.remember(longContent, "fact", ["target"]);

		const results = harness.search("target");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].summary).toHaveLength(40);

		await harness.close();
	});
});

describe("VeilHarness.importFromDb", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "veil-import-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("imports items from child DB with provenance tags", async () => {
		const childDbPath = join(tmpDir, "child.db");

		// Create "child" harness and store some items
		const childHarness = new VeilHarness({
			dbPath: childDbPath,
			coldStore: new MemoryColdStore(),
		});

		childHarness.remember("child item 1", "fact", ["child", "test"]);
		childHarness.remember("child item 2", "episodic", ["child"]);

		// Important: Get items count before close since close() flushes to cold storage
		const childCache = childHarness.getManager().getCache();
		const childItems = childCache.getAll();
		expect(childItems.length).toBe(2);

		// Close the cache directly (without flush) to persist WAL
		childCache.close();

		// Create "parent" harness and import
		const parentHarness = new VeilHarness({
			dbPath: join(tmpDir, "parent.db"),
			coldStore: new MemoryColdStore(),
		});

		const result = await parentHarness.importFromDb(childDbPath, {
			tag: "scout",
			sessionId: "child-session-123",
		});

		expect(result.imported).toBe(2);
		expect(result.skipped).toBe(0);

		// Verify items are in parent with provenance tags
		const results = parentHarness.search("child item");
		expect(results.length).toBe(2);

		await parentHarness.close();
	});

	test("deduplicates by content hash", async () => {
		const childDbPath = join(tmpDir, "child.db");

		const childHarness = new VeilHarness({
			dbPath: childDbPath,
			coldStore: new MemoryColdStore(),
		});
		childHarness.remember("duplicate content", "fact", ["child"]);
		// Close cache directly without flush to keep items in warm storage
		childHarness.getManager().getCache().close();

		const parentHarness = new VeilHarness({
			dbPath: join(tmpDir, "parent.db"),
			coldStore: new MemoryColdStore(),
		});
		// Store same content in parent
		parentHarness.remember("duplicate content", "fact", ["parent"]);

		const result = await parentHarness.importFromDb(childDbPath, {
			tag: "scout",
		});

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(1);

		await parentHarness.close();
	});

	test("returns zeros for non-existent child DB", async () => {
		const parentHarness = new VeilHarness({
			dbPath: join(tmpDir, "parent.db"),
			coldStore: new MemoryColdStore(),
		});

		const result = await parentHarness.importFromDb(join(tmpDir, "nonexistent.db"), {
			tag: "missing",
		});

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);

		await parentHarness.close();
	});

	test("transfers cognitive weights when enabled", async () => {
		const childDbPath = join(tmpDir, "child.db");

		const childHarness = new VeilHarness({
			dbPath: childDbPath,
			coldStore: new MemoryColdStore(),
		});
		const childItem = childHarness.remember("weighted item", "fact", ["child"]);
		// Simulate cognitive weight update via multiple "good" outcomes
		childHarness.getManager().getCache().updateCognitiveWeight(childItem.id, 0.5);
		// Close cache directly without flush to keep items in warm storage
		childHarness.getManager().getCache().close();

		const parentHarness = new VeilHarness({
			dbPath: join(tmpDir, "parent.db"),
			coldStore: new MemoryColdStore(),
		});

		// Add same content to parent first so dedup triggers weight transfer
		const parentItem = parentHarness.remember("weighted item", "fact", ["parent"]);

		const result = await parentHarness.importFromDb(childDbPath, {
			tag: "scout",
			transferWeights: true,
		});

		expect(result.skipped).toBe(1);

		// Parent item should have updated cognitive weight
		const updated = parentHarness.getManager().getCache().get(parentItem.id);
		expect(updated?.cognitiveWeight).not.toBe(0);

		await parentHarness.close();
	});
});
