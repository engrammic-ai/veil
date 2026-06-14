// packages/engrammic/src/commands/context.test.ts

import { describe, expect, it } from "vitest";
import type { VeilHarness } from "../harness.ts";
import type { ContextBudget, ContextItem, ContextWindow } from "../types.ts";
import { renderContextCommand } from "./context.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "abcdef1234567890",
		content: "Some test content here for the item",
		contentHash: "hash1",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		decayScore: 1.0,
		cognitiveWeight: 0,
		type: "fact",
		tags: ["test"],
		pinned: false,
		...overrides,
	};
}

function makeHarness(opts: {
	items?: ContextItem[];
	budget?: Partial<ContextBudget>;
	turnCount?: number;
	warmStats?: { episodic: number; fact: number; procedural: number };
	coldPointers?: number;
}): VeilHarness {
	const budget: ContextBudget = {
		maxTokens: 8000,
		usedTokens: opts.budget?.usedTokens ?? 0,
		reserveTokens: opts.budget?.reserveTokens ?? 1000,
		...opts.budget,
	};

	const window: ContextWindow = {
		items: opts.items ?? [],
		budget,
	};

	const warm = opts.warmStats ?? { episodic: 0, fact: 0, procedural: 0 };

	return {
		getWindow: () => window,
		getTurnCount: () => opts.turnCount ?? 0,
		getManager: () => ({
			getStats: () => ({
				warm,
				coldPointers: opts.coldPointers ?? 0,
			}),
			getConfig: () => ({
				checkpointIntervalTurns: 10,
			}),
		}),
	} as unknown as VeilHarness;
}

describe("renderContextCommand", () => {
	it("renders with empty context", () => {
		const harness = makeHarness({});
		const { lines } = renderContextCommand(harness);

		expect(lines).toContain("--- Veil Context ---");
		expect(lines).toContain("  (no items loaded)");
		expect(lines.some((l) => l.startsWith("HOT (0 items"))).toBe(true);
		expect(lines.some((l) => l.startsWith("WARM:"))).toBe(true);
		expect(lines.some((l) => l.startsWith("COLD:"))).toBe(true);
		expect(lines.some((l) => l.startsWith("Budget:"))).toBe(true);
		expect(lines).toContain("--------------------");
	});

	it("renders loaded items correctly", () => {
		const item = makeItem({
			id: "aabbccdd11223344",
			type: "episodic",
			content: "Episodic memory item content here",
			pinned: true,
		});
		const harness = makeHarness({ items: [item], warmStats: { episodic: 1, fact: 0, procedural: 0 } });
		const { lines } = renderContextCommand(harness);

		expect(lines.some((l) => l.startsWith("HOT (1 items"))).toBe(true);
		// Should have an item line with EPISODE prefix and [P] for pinned
		expect(lines.some((l) => l.includes("[EPISODE:aabbccdd]") && l.includes("[P]"))).toBe(true);
		// Should not show "(no items loaded)"
		expect(lines).not.toContain("  (no items loaded)");
	});

	it("checkpoint at turn 0 shows turn 10 (in 10 turns)", () => {
		const harness = makeHarness({ turnCount: 0 });
		const { lines } = renderContextCommand(harness);

		const checkpointLine = lines.find((l) => l.startsWith("Next checkpoint:"));
		expect(checkpointLine).toBe("Next checkpoint: turn 10 (in 10 turns)");
	});

	it("checkpoint at turn 5 shows turn 10 (in 5 turns)", () => {
		const harness = makeHarness({ turnCount: 5 });
		const { lines } = renderContextCommand(harness);

		const checkpointLine = lines.find((l) => l.startsWith("Next checkpoint:"));
		expect(checkpointLine).toBe("Next checkpoint: turn 10 (in 5 turns)");
	});

	it("checkpoint at turn 10 shows turn 20 (in 10 turns)", () => {
		const harness = makeHarness({ turnCount: 10 });
		const { lines } = renderContextCommand(harness);

		const checkpointLine = lines.find((l) => l.startsWith("Next checkpoint:"));
		expect(checkpointLine).toBe("Next checkpoint: turn 20 (in 10 turns)");
	});
});
