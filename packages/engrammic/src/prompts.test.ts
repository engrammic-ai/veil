// packages/engrammic/src/prompts.test.ts

import { describe, expect, it } from "vitest";
import { buildCheckpointPrompt, type CheckpointPromptOptions, CONTEXT_MANAGEMENT_PROMPT } from "./prompts.ts";

describe("CONTEXT_MANAGEMENT_PROMPT", () => {
	it("is a non-empty string", () => {
		expect(typeof CONTEXT_MANAGEMENT_PROMPT).toBe("string");
		expect(CONTEXT_MANAGEMENT_PROMPT.length).toBeGreaterThan(0);
	});
});

describe("buildCheckpointPrompt", () => {
	it("returns a string with checkpoint tags and stats for normal inputs", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 5,
			items: [
				{ stub: "[EPISODE:abc123:summary of something]", score: 0.9, tokens: 200, pinned: false },
				{ stub: "[EPISODE:def456:another item]", score: 0.7, tokens: 500, pinned: true },
			],
			budget: { usedTokens: 2000, maxTokens: 10000 },
		};

		const result = buildCheckpointPrompt(options);

		expect(result).toContain('<context-checkpoint turn="5">');
		expect(result).toContain("</context-checkpoint>");
		expect(result).toContain("HOT (2 items");
		expect(result).toContain("budget 80% free");
		expect(result).toContain("[EPISODE:abc123:summary of something]");
		expect(result).toContain("pinned");
	});

	it("returns a checkpoint with zero items", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 1,
			items: [],
			budget: { usedTokens: 0, maxTokens: 10000 },
		};

		const result = buildCheckpointPrompt(options);

		expect(result).toContain('<context-checkpoint turn="1">');
		expect(result).toContain("HOT (0 items");
		// No low-scoring section when items list is empty
		expect(result).not.toContain("Low-scoring candidates");
	});

	it("lists low-scoring item IDs without brackets", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 3,
			items: [
				// stub with summary part: [EPISODE:abc123:some summary] → ID should be "abc123"
				{ stub: "[EPISODE:abc123:some summary]", score: 0.2, tokens: 100, pinned: false },
				// stub without summary part: [EPISODE:xyz789] → ID should be "xyz789" (not "xyz789]")
				{ stub: "[EPISODE:xyz789]", score: 0.1, tokens: 50, pinned: false },
				// pinned item should be excluded from low-scoring candidates
				{ stub: "[EPISODE:pinned01:pinned thing]", score: 0.1, tokens: 80, pinned: true },
				// high-scoring item should be excluded
				{ stub: "[EPISODE:highscore:good item]", score: 0.9, tokens: 300, pinned: false },
			],
			budget: { usedTokens: 5000, maxTokens: 10000 },
		};

		const result = buildCheckpointPrompt(options);

		expect(result).toContain("Low-scoring candidates");

		// Extract just the Low-scoring candidates line to verify ID format
		const candidatesLine = result.split("\n").find((line) => line.startsWith("Low-scoring candidates:"));
		expect(candidatesLine).toBeDefined();

		// IDs must appear without surrounding brackets in the candidates line
		expect(candidatesLine).toContain("abc123");
		expect(candidatesLine).toContain("xyz789");

		// The extracted ID for [EPISODE:xyz789] must NOT include the closing bracket
		expect(candidatesLine).not.toContain("xyz789]");

		// Pinned and high-scoring items should not appear in low-scoring candidates line
		expect(candidatesLine).not.toContain("pinned01");
		expect(candidatesLine).not.toContain("highscore");
	});

	it("handles maxTokens=0 without dividing by zero (budget shows 0% free)", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 2,
			items: [],
			budget: { usedTokens: 0, maxTokens: 0 },
		};

		// Should not throw
		expect(() => buildCheckpointPrompt(options)).not.toThrow();

		const result = buildCheckpointPrompt(options);
		expect(result).toContain("budget 0% free");
	});
});
