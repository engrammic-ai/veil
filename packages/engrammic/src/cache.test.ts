import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ContextCache, createItem } from "./cache.ts";

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
