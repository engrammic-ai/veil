/**
 * Basic integration test for VeilHarness
 *
 * Note: Tests use MemoryColdStore to avoid native SQLite dependency issues.
 * Full SQLite tests should run in CI with proper native module builds.
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { MemoryColdStore } from "./cold/memory.ts";

// Set to true to skip SQLite tests if native module isn't built
const SKIP_SQLITE = false;

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
		assert.ok(pointer.startsWith("mem_"));

		const fetched = await store.fetch(pointer);
		assert.ok(fetched);
		assert.strictEqual(fetched.content, "Test content");
		assert.strictEqual(fetched.accessCount, 2); // incremented on fetch

		assert.strictEqual(await store.exists(pointer), true);

		await store.delete(pointer);
		assert.strictEqual(await store.exists(pointer), false);

		await store.close();
	});

	test("capabilities", () => {
		const store = new MemoryColdStore();
		assert.strictEqual(store.capabilities.semantic, false);
		assert.strictEqual(store.capabilities.temporal, false);
		assert.strictEqual(store.capabilities.provenance, false);
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VeilHarness } from "./harness.ts";

describe("VeilHarness", { skip: SKIP_SQLITE }, () => {
	// These tests require SQLite warm cache
	// Build native module: cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run build-release

	test("initializes with defaults", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
		try {
			const harness = new VeilHarness({
				dbPath: join(tmpDir, "context.db"),
				coldStore: new MemoryColdStore(),
			});

			const budget = harness.getBudget();
			assert.ok(budget.maxTokens > 0);
			assert.strictEqual(budget.usedTokens, 0);

			await harness.close();
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	});

	test("remember and recall", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
		try {
			const harness = new VeilHarness({
				dbPath: join(tmpDir, "context.db"),
				coldStore: new MemoryColdStore(),
			});

			const item = harness.remember("The API uses OAuth2 for authentication", "fact", ["auth", "api"]);

			assert.ok(item.id);
			assert.strictEqual(item.type, "fact");

			const recalled = harness.recall(["auth"], 10);
			assert.strictEqual(recalled.length, 1);
			assert.strictEqual(recalled[0].content, "The API uses OAuth2 for authentication");

			await harness.close();
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	});

	test("load and unload affect budget", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
		try {
			const harness = new VeilHarness({
				dbPath: join(tmpDir, "context.db"),
				coldStore: new MemoryColdStore(),
			});

			const item = harness.remember("Some content", "episodic", ["test"]);

			assert.strictEqual(harness.getBudget().usedTokens, 0);

			harness.load([item.id]);
			assert.ok(harness.getBudget().usedTokens > 0);

			const window = harness.getWindow();
			assert.strictEqual(window.items.length, 1);

			harness.unload([item.id]);
			assert.strictEqual(harness.getBudget().usedTokens, 0);

			await harness.close();
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	});

	test("hooks integrate with agent loop", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
		try {
			const checkpoints: number[] = [];

			const harness = new VeilHarness({
				dbPath: join(tmpDir, "context.db"),
				coldStore: new MemoryColdStore(),
				checkpointIntervalTurns: 2,
				onCheckpoint: (turn) => checkpoints.push(turn),
			});

			const hooks = harness.getHooks();
			assert.ok(hooks.beforeToolCall);
			assert.ok(hooks.afterToolCall);

			// Simulate tool calls
			await hooks.beforeToolCall({ toolCall: { name: "Read" }, args: { file_path: "/test.ts" } });
			await hooks.afterToolCall({ toolCall: { name: "Read" }, result: { isError: false } });

			assert.strictEqual(harness.getTurnCount(), 1);

			await hooks.afterToolCall({ toolCall: { name: "Write" }, result: { isError: false } });
			assert.strictEqual(harness.getTurnCount(), 2);
			assert.strictEqual(checkpoints.length, 1); // Checkpoint at turn 2

			await harness.close();
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	});

	test("pin prevents eviction", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "veil-test-"));
		try {
			const harness = new VeilHarness({
				dbPath: join(tmpDir, "context.db"),
				coldStore: new MemoryColdStore(),
			});

			const item = harness.remember("Important info", "procedural", ["critical"]);
			harness.load([item.id]);
			harness.pin(item.id);

			const window = harness.getWindow();
			assert.strictEqual(window.items[0].pinned, true);

			harness.unpin(item.id);
			const window2 = harness.getWindow();
			assert.strictEqual(window2.items[0].pinned, false);

			await harness.close();
		} finally {
			rmSync(tmpDir, { recursive: true });
		}
	});
});
