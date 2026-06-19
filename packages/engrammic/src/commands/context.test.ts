import { describe, expect, it } from "vitest";
import type { SearchResult, VeilHarness } from "../harness.ts";
import type { ContextBudget, ContextItem, ContextWindow } from "../types.ts";
import { renderContextCommand, renderContextSearch } from "./context.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "abcdef1234567890",
		content: "Some test content here for the item",
		contentHash: "hash1",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
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
	searchResults?: SearchResult[];
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
		search: (_query: string, _limit?: number) => opts.searchResults ?? [],
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

describe("renderContextSearch", () => {
	it("renders box with search header", async () => {
		const harness = makeHarness({ searchResults: [] });
		const { lines } = await renderContextSearch(harness, "auth");

		expect(lines[0]).toContain("+--");
		expect(lines[0]).toContain("Context Search");
		expect(lines[lines.length - 1]).toContain("+--");
	});

	it("shows query in results header", async () => {
		const harness = makeHarness({ searchResults: [] });
		const { lines } = await renderContextSearch(harness, "auth");
		const joined = lines.join("\n");

		expect(joined).toContain('Results for "auth"');
	});

	it("shows no results message for empty results", async () => {
		const harness = makeHarness({ searchResults: [] });
		const { lines } = await renderContextSearch(harness, "auth");
		const joined = lines.join("\n");

		expect(joined).toContain("(no results)");
	});

	it("formats results with tier, id, type and token count", async () => {
		const results: SearchResult[] = [
			{
				id: "abc123def456",
				tier: "hot",
				type: "episodic",
				summary: "src/auth.ts",
				tokens: 1200,
				score: 1.0,
				tags: ["auth"],
			},
			{
				id: "def456abc789",
				tier: "warm",
				type: "fact",
				summary: "API uses OAuth2",
				tokens: 45,
				score: 0.8,
				tags: ["auth", "api"],
			},
		];
		const harness = makeHarness({ searchResults: results });
		const { lines } = await renderContextSearch(harness, "auth");
		const joined = lines.join("\n");

		expect(joined).toContain("[hot]");
		expect(joined).toContain("[warm]");
		expect(joined).toContain("abc123");
		expect(joined).toContain("def456");
		expect(joined).toContain("episodic:");
		expect(joined).toContain("fact:");
	});

	it("shows summary line with tier counts", async () => {
		const results: SearchResult[] = [
			{
				id: "aaa111",
				tier: "hot",
				type: "fact",
				summary: "hot fact",
				tokens: 10,
				score: 1.0,
				tags: [],
			},
			{
				id: "bbb222",
				tier: "warm",
				type: "episodic",
				summary: "warm episodic",
				tokens: 20,
				score: 0.8,
				tags: [],
			},
		];
		const harness = makeHarness({ searchResults: results });
		const { lines } = await renderContextSearch(harness, "test");
		const joined = lines.join("\n");

		expect(joined).toContain("2 results");
		expect(joined).toContain("1 hot");
		expect(joined).toContain("1 warm");
	});
});
