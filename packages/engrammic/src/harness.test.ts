/**
 * Basic integration test for VeilHarness
 *
 * Note: Tests use MemoryColdStore to avoid native SQLite dependency issues.
 * Full SQLite tests should run in CI with proper native module builds.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
			decayScore: 1.0,
			cognitiveWeight: 0,
			type: "fact" as const,
			tags: ["test"],
			pinned: false,
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

		const recalled = harness.recall(["auth"], 10);
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

		expect(harness.getBudget().usedTokens).toBe(0);

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

		// Content should be stored in warm cache
		const recalled = harness.recall(["file", "read"], 10);
		expect(recalled.length).toBe(1);
		expect(recalled[0].content).toBe(fileContent);

		await harness.close();
	});

	test("ignores non-capturable tools", async () => {
		const harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			coldStore: new MemoryColdStore(),
		});

		const { mockAgentHarness, emit } = makeMockAgentHarness();
		harness.subscribeToEvents(mockAgentHarness);

		// Edit is not in the capture rules — should be ignored
		emit({
			toolName: "Edit",
			input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
			content: [{ type: "text", text: "The file has been edited successfully with the new changes applied." }],
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
		expect(allItems[0].content).toBe(identicalContent);

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
