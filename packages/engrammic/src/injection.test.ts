// packages/engrammic/src/injection.test.ts

import { describe, expect, test } from "vitest";
import type { AttemptRecord } from "./attempts.ts";
import { buildContextSection, buildFailureSection, formatStub, formatTurnAge } from "./injection.ts";
import type { ContextItem } from "./types.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "test-id",
		content: "Test content for the item",
		contentHash: "abc123",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		decayScore: 1.0,
		cognitiveWeight: 0,
		type: "episodic",
		tags: ["test"],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

describe("formatStub", () => {
	test("formats episodic item", () => {
		const item = makeItem({ id: "abc123", type: "episodic", content: "explored auth flow" });
		const stub = formatStub(item);
		expect(stub).toBe("[EPISODE:abc123:explored auth flow]");
	});

	test("formats fact item", () => {
		const item = makeItem({ id: "def456", type: "fact", content: "user model has email" });
		const stub = formatStub(item);
		expect(stub).toBe("[FACT:def456:user model has email]");
	});

	test("formats procedural item", () => {
		const item = makeItem({ id: "ghi789", type: "procedural", content: "test conventions" });
		const stub = formatStub(item);
		expect(stub).toBe("[PROC:ghi789:test conventions]");
	});

	test("truncates long content to 50 chars", () => {
		const item = makeItem({
			id: "long",
			content: "This is a very long content string that should be truncated to fifty characters",
		});
		const stub = formatStub(item);
		expect(stub.length).toBeLessThan(70); // [EPISODE:long:...50 chars...]
	});

	test("replaces newlines with spaces", () => {
		const item = makeItem({ id: "multi", content: "line one\nline two\nline three" });
		const stub = formatStub(item);
		expect(stub).not.toContain("\n");
		expect(stub).toContain("line one line two");
	});
});

describe("buildContextSection", () => {
	test("returns empty message when no items", () => {
		const section = buildContextSection({ items: [], budget: { usedTokens: 0, maxTokens: 128000 } });
		expect(section).toContain("No items loaded");
		expect(section).toContain("<veil-context>");
		expect(section).toContain("</veil-context>");
	});

	test("lists items with stubs, scores, and tokens", () => {
		const items = [
			{ item: makeItem({ id: "a", type: "episodic", content: "first item content here" }), score: 0.7 },
			{ item: makeItem({ id: "b", type: "fact", content: "second item content", pinned: true }), score: 0.85 },
		];
		const section = buildContextSection({ items, budget: { usedTokens: 100, maxTokens: 128000 } });

		expect(section).toContain("[EPISODE:a:");
		expect(section).toContain("[FACT:b:");
		expect(section).toContain("score: 0.70");
		expect(section).toContain("pinned");
		expect(section).toContain("2 items");
	});

	test("includes usage instructions", () => {
		const items = [{ item: makeItem(), score: 0.5 }];
		const section = buildContextSection({ items, budget: { usedTokens: 50, maxTokens: 128000 } });

		expect(section).toContain("hydrate");
		expect(section).toContain("recall");
	});

	test("uses singular 'item' for exactly one item", () => {
		const items = [{ item: makeItem({ id: "solo", type: "episodic", content: "solo item" }), score: 0.9 }];
		const section = buildContextSection({ items, budget: { usedTokens: 10, maxTokens: 128000 } });

		expect(section).toContain("1 item,");
		expect(section).not.toContain("1 items");
	});
});

// ─── D.2 — Failure Surfacing ──────────────────────────────────────────────────

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
	return {
		id: "attempt-1",
		sessionId: "session-1",
		goalId: "file:auth.ts",
		iteration: 1,
		action: "bash",
		target: "auth.ts",
		outcome: "fail",
		evidence: "TypeError: Cannot read property 'user' of undefined",
		errorPattern: "property-access-error",
		createdAt: Date.now(),
		turn: 1,
		goalOpen: true,
		pinned: false,
		...overrides,
	};
}

describe("formatTurnAge", () => {
	test("formats 0 turns as 'this turn'", () => {
		expect(formatTurnAge(0)).toBe("this turn");
	});

	test("formats 1 turn as '1 turn ago'", () => {
		expect(formatTurnAge(1)).toBe("1 turn ago");
	});

	test("formats multiple turns as 'N turns ago'", () => {
		expect(formatTurnAge(5)).toBe("5 turns ago");
		expect(formatTurnAge(10)).toBe("10 turns ago");
	});
});

describe("buildFailureSection", () => {
	test("returns empty string for no attempts", () => {
		const section = buildFailureSection({ attempts: [], currentTurn: 5 });
		expect(section).toBe("");
	});

	test("returns empty string when all attempts are pass", () => {
		const attempts = [makeAttempt({ outcome: "pass" })];
		const section = buildFailureSection({ attempts, currentTurn: 5 });
		expect(section).toBe("");
	});

	test("builds section with single failure", () => {
		const attempts = [makeAttempt({ turn: 3 })];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain("<veil-failures");
		expect(section).toContain("</veil-failures>");
		expect(section).toContain("Already tried (1 attempt):");
		expect(section).toContain("2 turns ago");
		expect(section).toContain("bash: auth.ts");
		expect(section).toContain("FAILED: TypeError");
	});

	test("builds section with multiple failures", () => {
		const attempts = [
			makeAttempt({ id: "a1", turn: 1, action: "edit", target: "auth.ts:45" }),
			makeAttempt({ id: "a2", turn: 3, action: "bash", target: "npm test" }),
			makeAttempt({ id: "a3", turn: 4, action: "edit", target: "auth.ts:50" }),
		];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain("3 attempts");
		expect(section).toContain("1. [4 turns ago]");
		expect(section).toContain("2. [2 turns ago]");
		expect(section).toContain("3. [1 turn ago]");
	});

	test("caps at maxAttempts most recent failures", () => {
		const attempts = Array.from({ length: 10 }, (_, i) => makeAttempt({ id: `a${i}`, turn: i, iteration: i + 1 }));
		const section = buildFailureSection({ attempts, currentTurn: 15, maxAttempts: 5 });

		expect(section).toContain("5 attempts");
		expect(section).not.toContain("10 attempts");
	});

	test("shows pattern when repeated", () => {
		const attempts = [
			makeAttempt({ id: "a1", errorPattern: "property-access-error" }),
			makeAttempt({ id: "a2", errorPattern: "property-access-error" }),
			makeAttempt({ id: "a3", errorPattern: "different-error" }),
		];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain("Pattern: property-access-error (2 occurrences)");
	});

	test("excludes uncertain attempts with other outcomes", () => {
		const attempts = [makeAttempt({ id: "a1", outcome: "uncertain" }), makeAttempt({ id: "a2", outcome: "pass" })];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain("1 attempt");
	});

	test("includes goal in tag attribute", () => {
		const attempts = [makeAttempt({ goalId: "test:auth.spec.ts" })];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain('goal="test:auth.spec.ts"');
	});

	test("handles missing target", () => {
		const attempts = [makeAttempt({ target: undefined })];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain("(no target)");
	});

	test("truncates long evidence", () => {
		const longEvidence = "A".repeat(200);
		const attempts = [makeAttempt({ evidence: longEvidence })];
		const section = buildFailureSection({ attempts, currentTurn: 5 });

		expect(section).toContain(`FAILED: ${"A".repeat(100)}`);
		expect(section).not.toContain("A".repeat(101));
	});
});
