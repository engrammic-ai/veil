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
	it("returns a string with veil tags and stats for normal inputs", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 5,
			items: [
				{ stub: "[EPISODE:abc123:summary of something]", score: 0.9, tokens: 200, pinned: false },
				{ stub: "[EPISODE:def456:another item]", score: 0.7, tokens: 500, pinned: true },
			],
			budget: { usedTokens: 2000, maxTokens: 10000 },
		};

		const result = buildCheckpointPrompt(options);

		expect(result).toContain('<veil turn="5" free="80%">');
		expect(result).toContain("</veil>");
		expect(result).toContain("[abc123] 0.9");
		expect(result).toContain("[def456] 0.7 pin");
	});

	it("returns a checkpoint with zero items", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 1,
			items: [],
			budget: { usedTokens: 0, maxTokens: 10000 },
		};

		const result = buildCheckpointPrompt(options);

		expect(result).toContain('<veil turn="1" free="100%">');
		expect(result).not.toContain("Stale:");
	});

	it("lists stale item IDs", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 3,
			items: [
				{ stub: "[EPISODE:abc123:some summary]", score: 0.2, tokens: 100, pinned: false },
				{ stub: "[EPISODE:xyz789]", score: 0.1, tokens: 50, pinned: false },
				{ stub: "[EPISODE:pinned01:pinned thing]", score: 0.1, tokens: 80, pinned: true },
				{ stub: "[EPISODE:highscore:good item]", score: 0.9, tokens: 300, pinned: false },
			],
			budget: { usedTokens: 5000, maxTokens: 10000 },
		};

		const result = buildCheckpointPrompt(options);

		expect(result).toContain("Stale:");
		expect(result).toContain("abc123");
		expect(result).toContain("xyz789");
		expect(result).toContain("demote if not needed");

		// Pinned and high-scoring items should not appear in stale list
		expect(result).not.toMatch(/Stale:.*pinned01/);
		expect(result).not.toMatch(/Stale:.*highscore/);
	});

	it("handles maxTokens=0 without dividing by zero", () => {
		const options: CheckpointPromptOptions = {
			turnCount: 2,
			items: [],
			budget: { usedTokens: 0, maxTokens: 0 },
		};

		expect(() => buildCheckpointPrompt(options)).not.toThrow();

		const result = buildCheckpointPrompt(options);
		expect(result).toContain('free="0%"');
	});
});
