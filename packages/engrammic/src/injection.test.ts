// packages/engrammic/src/injection.test.ts

import { describe, expect, test } from "vitest";
import { buildContextSection, formatStub } from "./injection.ts";
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
