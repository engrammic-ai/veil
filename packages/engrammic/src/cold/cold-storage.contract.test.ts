/**
 * Contract tests for ColdStore interface.
 * Verifies SqliteColdStore implementation meets the ColdStore contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ContextItem } from "../types.ts";
import { SqliteColdStore } from "./sqlite.ts";

function makeContextItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: `item-${Date.now()}`,
		content: "test content",
		contentHash: "hash123",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
		decayScore: 0.5,
		cognitiveWeight: 0.0,
		stability: 0.5,
		difficulty: 0.5,
		type: "fact",
		tags: ["test"],
		pinned: false,
		source: "explicit",
		...overrides,
	};
}

describe("ColdStore contract: SqliteColdStore", () => {
	let store: SqliteColdStore;

	beforeEach(() => {
		store = new SqliteColdStore({ dbPath: ":memory:" });
	});

	afterEach(async () => {
		await store.close();
	});

	test("demote/fetch round-trip preserves item fields", async () => {
		const item = makeContextItem({
			id: "round-trip-item",
			content: "hello from cold storage",
			contentHash: "abc456",
			type: "episodic",
			tags: ["cold", "round-trip"],
			pinned: true,
			source: "auto",
		});

		const pointer = await store.demote(item);
		expect(typeof pointer).toBe("string");
		expect(pointer.length).toBeGreaterThan(0);

		const fetched = await store.fetch(pointer);
		expect(fetched).not.toBeNull();
		expect(fetched!.id).toBe(item.id);
		expect(fetched!.content).toBe(item.content);
		expect(fetched!.contentHash).toBe(item.contentHash);
		expect(fetched!.type).toBe(item.type);
		expect(fetched!.tags).toEqual(item.tags);
		expect(fetched!.pinned).toBe(item.pinned);
		expect(fetched!.source).toBe(item.source);
		expect(fetched!.decayScore).toBe(item.decayScore);
		expect(fetched!.cognitiveWeight).toBe(item.cognitiveWeight);
		expect(fetched!.accessCount).toBeGreaterThanOrEqual(item.accessCount);
	});

	test("demote/fetch round-trip preserves optional fields", async () => {
		const item = makeContextItem({
			dependsOn: ["dep-a", "dep-b"],
			validFrom: 1000,
			validUntil: 9000,
		});

		const pointer = await store.demote(item);
		const fetched = await store.fetch(pointer);

		expect(fetched).not.toBeNull();
		expect(fetched!.dependsOn).toEqual(["dep-a", "dep-b"]);
		expect(fetched!.validFrom).toBe(1000);
		expect(fetched!.validUntil).toBe(9000);
	});

	test("fetch returns null for unknown pointer", async () => {
		const result = await store.fetch("cold_does-not-exist");
		expect(result).toBeNull();
	});

	test("fetch returns null for empty string pointer", async () => {
		const result = await store.fetch("");
		expect(result).toBeNull();
	});

	test("delete removes item so fetch returns null", async () => {
		const item = makeContextItem();
		const pointer = await store.demote(item);

		// Verify it exists first
		const before = await store.fetch(pointer);
		expect(before).not.toBeNull();

		await store.delete(pointer);

		const after = await store.fetch(pointer);
		expect(after).toBeNull();
	});

	test("delete is idempotent - deleting non-existent pointer does not throw", async () => {
		await expect(store.delete("cold_nonexistent")).resolves.toBeUndefined();
	});

	test("exists returns true for stored item", async () => {
		const item = makeContextItem();
		const pointer = await store.demote(item);

		const found = await store.exists(pointer);
		expect(found).toBe(true);
	});

	test("exists returns false for missing pointer", async () => {
		const found = await store.exists("cold_does-not-exist");
		expect(found).toBe(false);
	});

	test("exists returns false after delete", async () => {
		const item = makeContextItem();
		const pointer = await store.demote(item);

		await store.delete(pointer);
		const found = await store.exists(pointer);
		expect(found).toBe(false);
	});

	test("count starts at zero", async () => {
		const n = await store.count();
		expect(n).toBe(0);
	});

	test("count increments on demote", async () => {
		await store.demote(makeContextItem({ id: "count-item-1" }));
		expect(await store.count()).toBe(1);

		await store.demote(makeContextItem({ id: "count-item-2" }));
		expect(await store.count()).toBe(2);

		await store.demote(makeContextItem({ id: "count-item-3" }));
		expect(await store.count()).toBe(3);
	});

	test("count decrements on delete", async () => {
		const p1 = await store.demote(makeContextItem({ id: "del-count-1" }));
		const p2 = await store.demote(makeContextItem({ id: "del-count-2" }));
		expect(await store.count()).toBe(2);

		await store.delete(p1);
		expect(await store.count()).toBe(1);

		await store.delete(p2);
		expect(await store.count()).toBe(0);
	});

	test("count is unaffected by delete of non-existent pointer", async () => {
		await store.demote(makeContextItem({ id: "stable-count" }));
		expect(await store.count()).toBe(1);

		await store.delete("cold_phantom");
		expect(await store.count()).toBe(1);
	});

	test("multiple demotes of same item id produce distinct pointers", async () => {
		const item = makeContextItem({ id: "shared-id" });
		const p1 = await store.demote(item);
		const p2 = await store.demote(item);

		expect(p1).not.toBe(p2);
		expect(await store.count()).toBe(2);
	});

	test("fetch increments access count", async () => {
		const item = makeContextItem({ accessCount: 1 });
		const pointer = await store.demote(item);

		const first = await store.fetch(pointer);
		const second = await store.fetch(pointer);

		expect(second!.accessCount).toBeGreaterThan(first!.accessCount);
	});
});
