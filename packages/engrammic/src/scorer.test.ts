import { describe, expect, test } from "vitest";
import { computeRelevance } from "./scorer.ts";
import type { ContextItem, TaskContext } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	const now = Date.now();
	return {
		id: "test_abc_123",
		content: "test content",
		contentHash: "abc123",
		createdAt: now,
		lastAccess: now,
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

describe("scorer source modifier", () => {
	test("explicit items score higher than auto items", () => {
		const taskCtx: TaskContext = { tags: ["test"] };
		const config = DEFAULT_CONFIG;

		const autoItem = makeItem({ source: "auto" });
		const explicitItem = makeItem({ source: "explicit" });

		const autoScore = computeRelevance(autoItem, taskCtx, config);
		const explicitScore = computeRelevance(explicitItem, taskCtx, config);

		expect(explicitScore).toBeGreaterThan(autoScore);
		// The 1.5x multiplier applies to the base score before clamping
		expect(explicitScore / autoScore).toBeCloseTo(1.5, 0);
	});
});

describe("scorer per-item half-life", () => {
	test("explicit items decay slower than auto items", () => {
		const taskCtx: TaskContext = { tags: ["test"] };
		const config = DEFAULT_CONFIG;

		const pastTime = Date.now() - 60 * 60 * 1000; // 60 minutes ago

		const autoItem = makeItem({ source: "auto", lastAccess: pastTime });
		const explicitItem = makeItem({ source: "explicit", lastAccess: pastTime });

		const autoScore = computeRelevance(autoItem, taskCtx, config);
		const explicitScore = computeRelevance(explicitItem, taskCtx, config);

		expect(explicitScore).toBeGreaterThan(autoScore * 1.5);
	});
});
