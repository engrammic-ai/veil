import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextCache, createItem } from "./cache.ts";
import { applyTaskSuccessSignal, FeedbackTracker } from "./feedback.ts";

function makeCache(): ContextCache {
	return new ContextCache(":memory:");
}

describe("FeedbackTracker", () => {
	let cache: ContextCache;
	let tracker: FeedbackTracker;

	beforeEach(() => {
		cache = makeCache();
		tracker = new FeedbackTracker();
	});

	afterEach(() => {
		cache.close();
	});

	it("recordInjection + recordReference marks item as used", () => {
		const item = createItem("test content", "fact", ["test"]);
		cache.put(item);

		tracker.recordInjection([item.id]);
		tracker.recordReference(item.id);

		const result = tracker.endTurn(cache);

		expect(result.used).toContain(item.id);
		expect(result.ignored).not.toContain(item.id);

		const updated = cache.get(item.id)!;
		expect(updated.usedCount).toBe(1);
		expect(updated.ignoredCount).toBe(0);
	});

	it("injected but not referenced increments ignoredCount", () => {
		const item = createItem("some fact", "fact", ["test"]);
		cache.put(item);

		tracker.recordInjection([item.id]);
		// No recordReference call

		const result = tracker.endTurn(cache);

		expect(result.ignored).toContain(item.id);
		expect(result.used).not.toContain(item.id);

		const updated = cache.get(item.id)!;
		expect(updated.usedCount).toBe(0);
		expect(updated.ignoredCount).toBe(1);
	});

	it("clears state after endTurn", () => {
		const item = createItem("fact", "fact", []);
		cache.put(item);

		tracker.recordInjection([item.id]);
		tracker.endTurn(cache);

		// Second turn: no injections recorded
		const result2 = tracker.endTurn(cache);
		expect(result2.used).toHaveLength(0);
		expect(result2.ignored).toHaveLength(0);
	});

	it("detects archive candidates when ignoredCount > usedCount * 3", () => {
		const item = createItem("rarely used fact", "fact", []);
		cache.put(item);

		// Inject without reference 4 times
		for (let i = 0; i < 4; i++) {
			tracker.recordInjection([item.id]);
			tracker.endTurn(cache);
		}

		// Use once
		tracker.recordInjection([item.id]);
		tracker.recordReference(item.id);
		const result = tracker.endTurn(cache);

		const updated = cache.get(item.id)!;
		expect(updated.ignoredCount).toBe(4);
		expect(updated.usedCount).toBe(1);
		// ignoredCount(4) > usedCount(1) * 3 → archive candidate
		expect(result.archiveCandidates).toContain(item.id);
	});

	it("does not flag item as archive candidate when ratio is acceptable", () => {
		const item = createItem("well-used fact", "fact", []);
		cache.put(item);

		// Use twice
		for (let i = 0; i < 2; i++) {
			tracker.recordInjection([item.id]);
			tracker.recordReference(item.id);
			tracker.endTurn(cache);
		}

		// Ignore once
		tracker.recordInjection([item.id]);
		const result = tracker.endTurn(cache);

		expect(result.archiveCandidates).not.toContain(item.id);
	});

	it("handles multiple items in one turn", () => {
		const a = createItem("item a", "fact", []);
		const b = createItem("item b", "fact", []);
		cache.put(a);
		cache.put(b);

		tracker.recordInjection([a.id, b.id]);
		tracker.recordReference(a.id);

		const result = tracker.endTurn(cache);

		expect(result.used).toContain(a.id);
		expect(result.ignored).toContain(b.id);
	});
});

describe("applyTaskSuccessSignal", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	afterEach(() => {
		cache.close();
	});

	it("boosts cognitiveWeight for used items", () => {
		const item = createItem("used item", "fact", []);
		cache.put(item);

		applyTaskSuccessSignal(cache, [item.id], [item.id]);

		const updated = cache.get(item.id)!;
		expect(updated.cognitiveWeight).toBeGreaterThan(0);
	});

	it("penalizes cognitiveWeight for unused items", () => {
		const item = createItem("unused item", "fact", []);
		cache.put(item);

		applyTaskSuccessSignal(cache, [], [item.id]);

		const updated = cache.get(item.id)!;
		expect(updated.cognitiveWeight).toBeLessThan(0);
	});

	it("boost is capped at 1.0", () => {
		const item = createItem("frequently used", "fact", []);
		cache.put(item);

		// Apply many boosts
		for (let i = 0; i < 30; i++) {
			applyTaskSuccessSignal(cache, [item.id], [item.id]);
		}

		const updated = cache.get(item.id)!;
		expect(updated.cognitiveWeight).toBeLessThanOrEqual(1.0);
	});

	it("penalty is capped at -1.0", () => {
		const item = createItem("never used", "fact", []);
		cache.put(item);

		for (let i = 0; i < 60; i++) {
			applyTaskSuccessSignal(cache, [], [item.id]);
		}

		const updated = cache.get(item.id)!;
		expect(updated.cognitiveWeight).toBeGreaterThanOrEqual(-1.0);
	});

	it("does nothing when lists are empty", () => {
		const item = createItem("untouched", "fact", []);
		cache.put(item);

		applyTaskSuccessSignal(cache, [], []);

		const updated = cache.get(item.id)!;
		expect(updated.cognitiveWeight).toBe(0);
	});
});
