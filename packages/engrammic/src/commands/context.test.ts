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
		stability: 0.5,
		difficulty: 0.5,
		type: "fact",
		tags: ["test"],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

function makeHarness(opts: {
	items?: ContextItem[];
	budget?: Partial<ContextBudget>;
	turnCount?: number;
	warmStats?: { episodic: number; fact: number; procedural: number };
	coldPointers?: number;
	threshold?: number;
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
			getStats: async () => ({
				warm,
				coldPointers: opts.coldPointers ?? 0,
			}),
			getConfig: () => ({
				checkpointIntervalTurns: 10,
				evictionThresholdDefault: opts.threshold ?? 0.7,
			}),
		}),
	} as unknown as VeilHarness;
}

describe("renderContextCommand", () => {
	it("renders box format with header", async () => {
		const harness = makeHarness({});
		const { lines } = await renderContextCommand(harness);

		expect(lines[0]).toContain("+--");
		expect(lines[0]).toContain("Context Window");
		expect(lines[lines.length - 1]).toContain("+--");
	});

	it("shows hot items section", async () => {
		const harness = makeHarness({ items: [] });
		const { lines } = await renderContextCommand(harness);
		const joined = lines.join("\n");

		expect(joined).toContain("Hot (loaded):");
		expect(joined).toContain("0 items");
	});

	it("renders loaded items with details", async () => {
		const item = makeItem({
			id: "aabbccdd11223344",
			type: "episodic",
			content: "Episodic memory item content here",
			pinned: true,
			source: "explicit",
		});
		const harness = makeHarness({ items: [item], warmStats: { episodic: 1, fact: 0, procedural: 0 } });
		const { lines } = await renderContextCommand(harness);
		const joined = lines.join("\n");

		expect(joined).toContain("1 items");
		expect(joined).toContain("explicit");
		expect(joined).toContain("[pin]");
	});

	it("shows warm and cold counts", async () => {
		const harness = makeHarness({
			warmStats: { episodic: 10, fact: 20, procedural: 5 },
			coldPointers: 100,
		});
		const { lines } = await renderContextCommand(harness);
		const joined = lines.join("\n");

		expect(joined).toContain("Warm (cached):");
		expect(joined).toContain("35 items");
		expect(joined).toContain("Cold (storage):");
	});

	it("shows budget with progress bar", async () => {
		const harness = makeHarness({
			budget: { usedTokens: 2000, maxTokens: 8000, reserveTokens: 1000 },
		});
		const { lines } = await renderContextCommand(harness);
		const joined = lines.join("\n");

		expect(joined).toContain("Budget:");
		expect(joined).toContain("2k");
		expect(joined).toContain("8k");
		expect(joined).toMatch(/[=.]+/);
	});

	it("shows adaptive threshold", async () => {
		const harness = makeHarness({ threshold: 0.75 });
		const { lines } = await renderContextCommand(harness);
		const joined = lines.join("\n");

		expect(joined).toContain("Threshold:");
		expect(joined).toContain("75%");
	});
});
