import { describe, expect, test, vi } from "vitest";
import { analyzePatterns, patternToTrigger } from "./learning.ts";
import type { LearnedPattern } from "./learning.ts";
import type { ContextItem, Trigger } from "./types.ts";
import type { HydrationEvent } from "./cache.ts";

// Minimal mock cache
function makeCache(items: ContextItem[] = []) {
	return {
		get: vi.fn((id: string) => items.find((i) => i.id === id) ?? null),
	} as any;
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

function makeEvent(overrides: Partial<HydrationEvent> = {}): HydrationEvent {
	return {
		sessionId: "session-1",
		itemId: "item-1",
		triggerIds: ["trigger-1"],
		userMessage: "can you run the tests",
		hydratedAt: Date.now(),
		latencyMs: 10,
		...overrides,
	};
}

// -----------------------------------------------------------------------
// analyzePatterns
// -----------------------------------------------------------------------

describe("analyzePatterns", () => {
	test("finds patterns from hydration events", () => {
		const item = makeItem({ id: "item-1", tags: ["testing"] });
		const cache = makeCache([item]);
		const events = [
			makeEvent({ userMessage: "run the tests now" }),
			makeEvent({ userMessage: "run the tests again" }),
			makeEvent({ userMessage: "run the tests please" }),
		];

		const patterns = analyzePatterns(events, cache, [], 0.5, 3);

		expect(patterns.length).toBeGreaterThan(0);
		expect(patterns[0].tags).toContain("testing");
		expect(patterns[0].confidence).toBeGreaterThanOrEqual(0.5);
		expect(patterns[0].sampleSize).toBe(3);
	});

	test("respects minSamples threshold", () => {
		const item = makeItem({ id: "item-1", tags: ["testing"] });
		const cache = makeCache([item]);
		// Only 2 events but minSamples=3
		const events = [
			makeEvent({ userMessage: "run the tests now" }),
			makeEvent({ userMessage: "run the tests again" }),
		];

		const patterns = analyzePatterns(events, cache, [], 0.5, 3);

		expect(patterns).toHaveLength(0);
	});

	test("respects minConfidence threshold", () => {
		const item = makeItem({ id: "item-1", tags: ["debugging"] });
		const cache = makeCache([item]);
		// Messages with mixed words - low confidence pattern
		const events = [
			makeEvent({ userMessage: "fix the authentication flow" }),
			makeEvent({ userMessage: "deploy the application now" }),
			makeEvent({ userMessage: "review the code changes" }),
			makeEvent({ userMessage: "run all tests quickly" }),
		];

		// Very high confidence threshold - unlikely these varied messages match
		const patterns = analyzePatterns(events, cache, [], 0.99, 3);

		// With highly varied messages and 0.99 threshold, no pattern should emerge
		// (each top word appears in at most 1-2/4 messages = 25-50% confidence)
		expect(patterns).toHaveLength(0);
	});

	test("skips tags already covered by existing triggers", () => {
		const item = makeItem({ id: "item-1", tags: ["auth"] });
		const cache = makeCache([item]);
		const events = [
			makeEvent({ userMessage: "fix the auth problem" }),
			makeEvent({ userMessage: "auth is broken again" }),
			makeEvent({ userMessage: "auth token expired" }),
		];

		const existingTriggers: Trigger[] = [
			{
				id: "auth",
				pattern: /auth/i,
				type: "keyword",
				action: { tags: ["auth"] },
				priority: 10,
				enabled: true,
			},
		];

		const patterns = analyzePatterns(events, cache, existingTriggers, 0.5, 3);

		expect(patterns).toHaveLength(0);
	});

	test("returns empty when no events reference cache items", () => {
		const item = makeItem({ id: "item-1", tags: ["testing"] });
		const cache = makeCache([item]);
		// Event references non-existent item
		const events = [
			makeEvent({ itemId: "does-not-exist", userMessage: "run the tests" }),
			makeEvent({ itemId: "does-not-exist", userMessage: "run the tests" }),
			makeEvent({ itemId: "does-not-exist", userMessage: "run the tests" }),
		];

		const patterns = analyzePatterns(events, cache, [], 0.5, 3);

		expect(patterns).toHaveLength(0);
	});

	test("handles multiple tags per item independently", () => {
		const item = makeItem({ id: "item-1", tags: ["deploy", "build"] });
		const cache = makeCache([item]);
		const events = [
			makeEvent({ userMessage: "deploy the build now" }),
			makeEvent({ userMessage: "deploy the build again" }),
			makeEvent({ userMessage: "deploy the build please" }),
		];

		const patterns = analyzePatterns(events, cache, [], 0.5, 3);

		// Should have patterns for both tags (or at least one of them)
		const tagsCovered = patterns.flatMap(p => p.tags);
		expect(tagsCovered.some(t => t === "deploy" || t === "build")).toBe(true);
	});
});

// -----------------------------------------------------------------------
// patternToTrigger
// -----------------------------------------------------------------------

describe("patternToTrigger", () => {
	test("generates a valid trigger from a learned pattern", () => {
		const pattern: LearnedPattern = {
			pattern: "\\btests\\b|\\brun\\b",
			tags: ["testing"],
			confidence: 0.9,
			sampleSize: 5,
		};

		const trigger = patternToTrigger(pattern, new Set());

		expect(trigger.id).toBe("learned_testing");
		expect(trigger.type).toBe("keyword");
		expect(trigger.action.tags).toEqual(["testing"]);
		expect(trigger.priority).toBe(5);
		expect(trigger.enabled).toBe(true);
		expect(trigger.learned).toBe(true);
		expect(trigger.confidence).toBe(0.9);
		expect(trigger.pattern).toBeInstanceOf(RegExp);
	});

	test("generates unique IDs when ID already exists", () => {
		const pattern: LearnedPattern = {
			pattern: "\\btests\\b",
			tags: ["testing"],
			confidence: 0.8,
			sampleSize: 3,
		};

		const existingIds = new Set(["learned_testing", "learned_testing_1"]);
		const trigger = patternToTrigger(pattern, existingIds);

		expect(trigger.id).toBe("learned_testing_2");
	});

	test("generates unique IDs for first collision", () => {
		const pattern: LearnedPattern = {
			pattern: "\\btests\\b",
			tags: ["testing"],
			confidence: 0.8,
			sampleSize: 3,
		};

		const existingIds = new Set(["learned_testing"]);
		const trigger = patternToTrigger(pattern, existingIds);

		expect(trigger.id).toBe("learned_testing_1");
	});

	test("uses base ID when no collision", () => {
		const pattern: LearnedPattern = {
			pattern: "\\bdeploy\\b",
			tags: ["deploy"],
			confidence: 0.75,
			sampleSize: 4,
		};

		const trigger = patternToTrigger(pattern, new Set());

		expect(trigger.id).toBe("learned_deploy");
	});

	test("creates regex with case-insensitive flag", () => {
		const pattern: LearnedPattern = {
			pattern: "\\bdeploy\\b",
			tags: ["deploy"],
			confidence: 0.75,
			sampleSize: 4,
		};

		const trigger = patternToTrigger(pattern, new Set());

		expect(trigger.pattern.flags).toContain("i");
		expect(trigger.pattern.test("Deploy now")).toBe(true);
		expect(trigger.pattern.test("DEPLOY this")).toBe(true);
	});

	test("joins multiple tags with underscore in ID", () => {
		const pattern: LearnedPattern = {
			pattern: "\\bdeploy\\b|\\bbuild\\b",
			tags: ["deploy", "build"],
			confidence: 0.8,
			sampleSize: 3,
		};

		const trigger = patternToTrigger(pattern, new Set());

		expect(trigger.id).toBe("learned_deploy_build");
	});
});

// -----------------------------------------------------------------------
// escapeRegex (via analyzePatterns with special-char tags/words)
// -----------------------------------------------------------------------

describe("escapeRegex (via pattern generation)", () => {
	test("handles messages with regex special characters without throwing", () => {
		const item = makeItem({ id: "item-1", tags: ["special"] });
		const cache = makeCache([item]);
		// Messages containing regex special chars
		const events = [
			makeEvent({ userMessage: "handle the (brackets) now" }),
			makeEvent({ userMessage: "handle the (brackets) again" }),
			makeEvent({ userMessage: "handle the (brackets) please" }),
		];

		// Should not throw even if words with special chars are top words
		expect(() => analyzePatterns(events, cache, [], 0.5, 3)).not.toThrow();
	});

	test("patterns produced are valid RegExp", () => {
		const item = makeItem({ id: "item-1", tags: ["build"] });
		const cache = makeCache([item]);
		const events = [
			makeEvent({ userMessage: "build the project now" }),
			makeEvent({ userMessage: "build the project again" }),
			makeEvent({ userMessage: "build the project please" }),
		];

		const patterns = analyzePatterns(events, cache, [], 0.5, 3);

		for (const p of patterns) {
			expect(() => new RegExp(p.pattern, 'i')).not.toThrow();
		}
	});
});
