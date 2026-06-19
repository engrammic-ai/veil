/**
 * Unit tests for EvictionController
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { EvictionController } from "./eviction.ts";
import { type ContextItem, type ContextManagerConfig, DEFAULT_CONFIG } from "./types.ts";

function createMockItem(overrides?: Partial<ContextItem>): ContextItem {
	return {
		id: "item-1",
		content: "test content",
		contentHash: "abc123",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
		decayScore: 0,
		cognitiveWeight: 0,
		stability: 0.5,
		difficulty: 0.5,
		type: "episodic",
		tags: [],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

describe("EvictionController", () => {
	let controller: EvictionController;
	let config: ContextManagerConfig;

	beforeEach(() => {
		config = { ...DEFAULT_CONFIG };
		controller = new EvictionController(config);
		vi.clearAllTimers();
	});

	describe("threshold management", () => {
		test("starts at default threshold (0.70)", () => {
			expect(controller.getThreshold()).toBe(0.7);
		});

		test("stays within min/max bounds", () => {
			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdMin: 0.6,
				evictionThresholdMax: 0.85,
				evictionThresholdDefault: 0.7,
			});

			expect(controller.getThreshold()).toBe(0.7);
		});

		test("lowers threshold when thrashing (3+ evictions in 60s)", () => {
			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdDefault: 0.7,
				evictionThresholdMin: 0.6,
			});

			const initialThreshold = controller.getThreshold();

			// Record 3 evictions rapidly
			controller.recordEviction();
			controller.recordEviction();
			controller.recordEviction();

			const newThreshold = controller.getThreshold();
			expect(newThreshold).toBeLessThan(initialThreshold);
			expect(newThreshold).toBeCloseTo(0.65, 5); // 0.70 - 0.05
		});

		test("does not lower threshold below minimum", () => {
			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdDefault: 0.6,
				evictionThresholdMin: 0.6,
			});

			// Try to thrash
			controller.recordEviction();
			controller.recordEviction();
			controller.recordEviction();

			expect(controller.getThreshold()).toBe(0.6); // Should not go below min
		});

		test("raises threshold after 5+ minutes of stability", () => {
			vi.useFakeTimers();

			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdDefault: 0.7,
				evictionThresholdMax: 0.85,
			});

			// First, record an eviction at time 0
			controller.recordEviction();
			expect(controller.getThreshold()).toBe(0.7);

			// Advance 5+ minutes (300001ms)
			vi.advanceTimersByTime(300001);

			// Adjust threshold based on stability
			controller.adjustThreshold();

			const newThreshold = controller.getThreshold();
			expect(newThreshold).toBeGreaterThan(0.7);
			expect(newThreshold).toBe(0.75); // 0.70 + 0.05

			vi.useRealTimers();
		});

		test("does not raise threshold on fresh controller (no prior evictions)", () => {
			vi.useFakeTimers();

			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdDefault: 0.7,
				evictionThresholdMax: 0.85,
			});

			// Do NOT record any evictions - fresh controller

			// Even after 5+ minutes, threshold should NOT raise
			vi.advanceTimersByTime(300001);
			controller.adjustThreshold();

			// Threshold should remain at default because no evictions have occurred
			expect(controller.getThreshold()).toBe(0.7);

			vi.useRealTimers();
		});

		test("does not raise threshold above maximum", () => {
			vi.useFakeTimers();

			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdDefault: 0.85,
				evictionThresholdMax: 0.85,
			});

			// Record an eviction, then wait
			controller.recordEviction();
			vi.advanceTimersByTime(300001);

			controller.adjustThreshold();

			expect(controller.getThreshold()).toBe(0.85); // Should not exceed max

			vi.useRealTimers();
		});

		test("clears old eviction timestamps outside 60s window", () => {
			vi.useFakeTimers();

			const controller = new EvictionController({
				...DEFAULT_CONFIG,
				evictionThresholdDefault: 0.7,
				evictionThresholdMin: 0.6,
			});

			// Record eviction at t=0
			controller.recordEviction();

			// Advance 65 seconds (65000ms) - beyond the 60s window
			vi.advanceTimersByTime(65000);

			// Record another eviction - old one should be pruned
			controller.recordEviction();

			// Should only have 1 recent eviction now, so threshold shouldn't drop
			controller.recordEviction();

			// At this point we have 2 evictions in the current window, not 3
			// So threshold shouldn't trigger the thrash threshold
			expect(controller.getThreshold()).toBe(0.7);

			vi.useRealTimers();
		});
	});

	describe("recall cooldowns", () => {
		test("items on cooldown are protected", () => {
			const itemId = "item-1";
			const currentTurn = 5;

			controller.setRecallCooldown(itemId, currentTurn);

			// Item should be on cooldown for next 4 turns (recallCooldownTurns = 5)
			expect(controller.isOnCooldown(itemId, currentTurn + 1)).toBe(true);
			expect(controller.isOnCooldown(itemId, currentTurn + 2)).toBe(true);
			expect(controller.isOnCooldown(itemId, currentTurn + 4)).toBe(true);

			// After cooldown expires
			expect(controller.isOnCooldown(itemId, currentTurn + 5)).toBe(false);
			expect(controller.isOnCooldown(itemId, currentTurn + 6)).toBe(false);
		});

		test("items not recalled have no cooldown", () => {
			const itemId = "item-999";
			const currentTurn = 10;

			expect(controller.isOnCooldown(itemId, currentTurn)).toBe(false);
			expect(controller.isOnCooldown(itemId, currentTurn + 100)).toBe(false);
		});

		test("clearExpiredCooldowns removes stale entries", () => {
			const item1 = "item-1";
			const item2 = "item-2";
			const item3 = "item-3";

			const currentTurn = 10;
			// recallCooldownTurns = 5

			// Set cooldowns at different turns
			controller.setRecallCooldown(item1, currentTurn - 6); // Expired (10-6=4, 4+5=9, so at turn 9+ it expires)
			controller.setRecallCooldown(item2, currentTurn - 2); // Still active (10-2=8, 8+5=13, expires at turn 13+)
			controller.setRecallCooldown(item3, currentTurn); // Just set (10+5=15, expires at turn 15+)

			// Before cleanup, check at turn 11
			expect(controller.isOnCooldown(item1, currentTurn + 1)).toBe(false); // 11-4=7, not < 5
			expect(controller.isOnCooldown(item2, currentTurn + 1)).toBe(true); // 11-8=3 < 5
			expect(controller.isOnCooldown(item3, currentTurn + 1)).toBe(true); // 11-10=1 < 5

			// Cleanup at turn 10
			controller.clearExpiredCooldowns(currentTurn);

			// After cleanup, verify cooldowns still work correctly at turn 10
			expect(controller.isOnCooldown(item1, currentTurn)).toBe(false); // 10-4=6, not < 5
			expect(controller.isOnCooldown(item2, currentTurn)).toBe(true); // 10-8=2 < 5
			expect(controller.isOnCooldown(item3, currentTurn)).toBe(true); // 10-10=0 < 5
		});
	});

	describe("item size capping", () => {
		test("truncates items exceeding 20% of budget", () => {
			const config: ContextManagerConfig = {
				...DEFAULT_CONFIG,
				maxItemBudgetRatio: 0.2,
			};
			const controller = new EvictionController(config);

			// Create an item with 10,000 chars (roughly 2,500 tokens)
			const largeContent = "x".repeat(10000);
			const item = createMockItem({
				content: largeContent,
			});

			// Budget is 1000 tokens, 20% = 200 tokens = 800 chars
			const budgetTokens = 1000;

			const result = controller.enforceItemSizeCap(item, budgetTokens);

			expect(result.content.length).toBeLessThan(largeContent.length);
			expect(result.tags).toContain("truncated");
		});

		test("leaves small items unchanged", () => {
			const config: ContextManagerConfig = {
				...DEFAULT_CONFIG,
				maxItemBudgetRatio: 0.2,
			};
			const controller = new EvictionController(config);

			const smallContent = "small";
			const item = createMockItem({
				content: smallContent,
				tags: [],
			});

			const budgetTokens = 1000; // 20% = 200 tokens = 800 chars

			const result = controller.enforceItemSizeCap(item, budgetTokens);

			expect(result.content).toBe(smallContent);
			expect(result.tags).not.toContain("truncated");
		});

		test("does not add duplicate 'truncated' tags", () => {
			const config: ContextManagerConfig = {
				...DEFAULT_CONFIG,
				maxItemBudgetRatio: 0.2,
			};
			const controller = new EvictionController(config);

			const largeContent = "x".repeat(10000);
			const item = createMockItem({
				content: largeContent,
				tags: ["truncated"],
			});

			const budgetTokens = 1000;

			controller.enforceItemSizeCap(item, budgetTokens);

			const truncatedCount = item.tags.filter((t) => t === "truncated").length;
			expect(truncatedCount).toBe(1);
		});

		test("preserves other tags while truncating", () => {
			const config: ContextManagerConfig = {
				...DEFAULT_CONFIG,
				maxItemBudgetRatio: 0.2,
			};
			const controller = new EvictionController(config);

			const largeContent = "x".repeat(10000);
			const item = createMockItem({
				content: largeContent,
				tags: ["important", "cached"],
			});

			const budgetTokens = 1000;

			const result = controller.enforceItemSizeCap(item, budgetTokens);

			expect(result.tags).toContain("important");
			expect(result.tags).toContain("cached");
			expect(result.tags).toContain("truncated");
		});
	});

	describe("EvictionController re-request back-off (AIMD)", () => {
		test("a single re-request raises the threshold by the back-off step", () => {
			const config = { ...DEFAULT_CONFIG };
			const c = new EvictionController(config);
			const before = c.getThreshold();
			c.recordReRequest();
			expect(c.getThreshold()).toBeCloseTo(before + config.reRequestBackoffStep);
		});

		test("repeated re-requests clamp at evictionThresholdMax", () => {
			const config = { ...DEFAULT_CONFIG };
			const c = new EvictionController(config);
			for (let i = 0; i < 100; i++) c.recordReRequest();
			expect(c.getThreshold()).toBeCloseTo(config.evictionThresholdMax);
		});
	});

	describe("edge cases", () => {
		test("recordEviction with zero budget tokens", () => {
			const item = createMockItem({ content: "test" });
			const budgetTokens = 0;

			// Should not crash
			const result = controller.enforceItemSizeCap(item, budgetTokens);
			expect(result).toBeDefined();
		});

		test("multiple rapid cooldown updates", () => {
			const itemId = "item-1";

			// Update cooldown multiple times
			controller.setRecallCooldown(itemId, 5);
			controller.setRecallCooldown(itemId, 10);
			controller.setRecallCooldown(itemId, 15);

			// Should use the latest update
			expect(controller.isOnCooldown(itemId, 16)).toBe(true);
			expect(controller.isOnCooldown(itemId, 20)).toBe(false); // 20 - 15 = 5, which is >= 5
		});
	});
});
