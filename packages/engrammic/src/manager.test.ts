import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MemoryColdStore } from "./cold/memory.ts";
import { ContextManager } from "./manager.ts";

// Loads several ~20-token items so total usage exceeds the budget and eviction fires.
// Each item is exactly at the per-item size cap (20% of 100 = 20 tokens = 80 chars), so it
// is NOT truncated on load, and 6 of them (120 tokens) exceed the 100-token budget.
function makeManager(testDir: string, overrides = {}) {
	return new ContextManager(
		{ dbPath: join(testDir, "ctx.db"), maxTokens: 100, reserveTokens: 0, ...overrides },
		new MemoryColdStore(),
	);
}

describe("ContextManager eviction ledger logging", () => {
	let testDir: string;
	let manager: ContextManager;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-mgr-evlog-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		manager = makeManager(testDir);
	});

	afterEach(async () => {
		await manager.close();
		rmSync(testDir, { recursive: true });
	});

	test("evicted items are recorded in the eviction ledger", async () => {
		for (let i = 0; i < 6; i++) {
			const item = manager.remember(`item ${i} `.padEnd(80, "x"), "episodic", ["t"]);
			manager.load([item.id]);
		}

		const evicted = await manager.checkEviction({ tags: ["t"] });
		expect(evicted.length).toBeGreaterThan(0);

		const hash = evicted[0].item.contentHash;
		const found = manager.getCache().findRecentEviction(hash, 60_000);
		expect(found).not.toBeNull();
		expect(found?.itemId).toBe(evicted[0].item.id);
	});
});

describe("ContextManager re-request miss detection", () => {
	let testDir: string;
	let manager: ContextManager;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-mgr-miss-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		manager = makeManager(testDir);
	});

	afterEach(async () => {
		await manager.close();
		rmSync(testDir, { recursive: true });
	});

	test("fetching an evicted item back from cold raises the threshold", async () => {
		for (let i = 0; i < 6; i++) {
			const item = manager.remember(`item ${i} `.padEnd(80, "x"), "episodic", ["t"]);
			manager.load([item.id]);
		}
		const evicted = await manager.checkEviction({ tags: ["t"] });
		const pointer = evicted[0].item.kgPointer;
		expect(pointer).toBeTruthy();

		const before = manager.getEvictionThreshold();
		await manager.fetchFromCold(pointer!);
		expect(manager.getEvictionThreshold()).toBeGreaterThan(before);
	});

	test("re-capturing recently-evicted content raises the threshold and consumes the ledger entry", async () => {
		for (let i = 0; i < 6; i++) {
			const item = manager.remember(`item ${i} `.padEnd(80, "x"), "episodic", ["t"]);
			manager.load([item.id]);
		}
		const evicted = await manager.checkEviction({ tags: ["t"] });
		const victim = evicted[0].item;

		const before = manager.getEvictionThreshold();
		// Simulate re-reading the evicted content (same content -> same hash)
		manager.remember(victim.content, "episodic", ["t"]);

		expect(manager.getEvictionThreshold()).toBeGreaterThan(before);
		expect(manager.getCache().findRecentEviction(victim.contentHash, 60_000)).toBeNull();
	});
});
