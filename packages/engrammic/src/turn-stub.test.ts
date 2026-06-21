import { describe, expect, it } from "vitest";
import type { ArchivedTurn } from "./conversation-archive.ts";
import { generateStub, groupConsecutiveTurns, summarizeAction } from "./turn-stub.ts";

function makeTurn(overrides: Partial<ArchivedTurn> & { turnNumber: number }): ArchivedTurn {
	return {
		turnId: `turn-${overrides.turnNumber}`,
		sessionId: "session-1",
		role: "assistant",
		content: "",
		...overrides,
	};
}

describe("groupConsecutiveTurns", () => {
	it("returns empty for empty input", () => {
		expect(groupConsecutiveTurns([])).toEqual([]);
	});

	it("groups a single number as a range", () => {
		expect(groupConsecutiveTurns([5])).toEqual([[5, 5]]);
	});

	it("groups consecutive numbers into one range", () => {
		expect(groupConsecutiveTurns([3, 4, 5])).toEqual([[3, 5]]);
	});

	it("splits non-consecutive numbers into separate ranges", () => {
		expect(groupConsecutiveTurns([1, 2, 5, 6, 10])).toEqual([
			[1, 2],
			[5, 6],
			[10, 10],
		]);
	});

	it("handles unsorted input", () => {
		expect(groupConsecutiveTurns([5, 3, 4])).toEqual([[3, 5]]);
	});

	it("handles a single-element non-consecutive group", () => {
		expect(groupConsecutiveTurns([1, 3, 5])).toEqual([
			[1, 1],
			[3, 3],
			[5, 5],
		]);
	});
});

describe("summarizeAction", () => {
	it("uses decisionSummary when present", () => {
		const turn = makeTurn({ turnNumber: 1, decisionSummary: "Use PKCE flow for OAuth" });
		expect(summarizeAction(turn)).toBe("Decided: Use PKCE flow for OAuth");
	});

	it("extracts decisions from decision metaType turns", () => {
		const turn = makeTurn({
			turnNumber: 1,
			metaType: "decision",
			content: "We decided to use PKCE flow for authentication",
		});
		const result = summarizeAction(turn);
		expect(result).toMatch(/Decided:/);
	});

	it("extracts file reads from content", () => {
		const turn = makeTurn({
			turnNumber: 2,
			content: "I read auth.ts and config.ts to understand the setup",
		});
		const result = summarizeAction(turn);
		expect(result).toMatch(/Read:/);
		expect(result).toMatch(/auth\.ts/);
	});

	it("prefers writes over reads", () => {
		const turn = makeTurn({
			turnNumber: 3,
			content: "I read config.ts then modified auth.ts to add PKCE",
		});
		const result = summarizeAction(turn);
		expect(result).toMatch(/Modified:/);
	});

	it("falls back to first line of content", () => {
		const turn = makeTurn({
			turnNumber: 4,
			content: "This is a general assistant response with no files",
		});
		const result = summarizeAction(turn);
		expect(result.length).toBeGreaterThan(5);
	});

	it("falls back to turn descriptor when content is empty", () => {
		const turn = makeTurn({ turnNumber: 5, content: "", metaType: "exploration" });
		const result = summarizeAction(turn);
		expect(result).toContain("5");
	});
});

describe("generateStub", () => {
	it("returns empty string for empty turns", () => {
		expect(generateStub({ turns: [] })).toBe("");
	});

	it("uses singular label for single turn", () => {
		const turn = makeTurn({ turnNumber: 5, content: "did something" });
		const stub = generateStub({ turns: [turn] });
		expect(stub).toContain("Turn 5 summarized");
	});

	it("shows range for multiple turns", () => {
		const turns = [
			makeTurn({ turnNumber: 5, content: "read auth.ts" }),
			makeTurn({ turnNumber: 6, content: "read config.ts" }),
			makeTurn({ turnNumber: 7, content: "read utils.ts" }),
			makeTurn({ turnNumber: 8, decisionSummary: "Use PKCE flow for OAuth" }),
		];
		const stub = generateStub({ turns });
		expect(stub).toContain("Turns 5-8 summarized");
	});

	it("lists each turn as a bullet", () => {
		const turns = [
			makeTurn({ turnNumber: 5, content: "read auth.ts" }),
			makeTurn({ turnNumber: 6, decisionSummary: "Use PKCE flow for OAuth" }),
		];
		const stub = generateStub({ turns });
		const bulletLines = stub.split("\n").filter((l) => l.startsWith("- "));
		expect(bulletLines).toHaveLength(2);
	});

	it("appends captured ids to bullet lines", () => {
		const turns = [
			makeTurn({ turnNumber: 5, content: "read auth.ts" }),
			makeTurn({ turnNumber: 6, content: "read config.ts" }),
		];
		const capturedIds = new Map([
			["turn-5", "abc123"],
			["turn-6", "def456"],
		]);
		const stub = generateStub({ turns, capturedIds });
		expect(stub).toContain("(captured: abc123)");
		expect(stub).toContain("(captured: def456)");
	});

	it("omits captured suffix when no captured ids", () => {
		const turns = [makeTurn({ turnNumber: 5, content: "did something" })];
		const stub = generateStub({ turns });
		expect(stub).not.toContain("captured:");
	});

	it("includes veil_history hint", () => {
		const turns = [makeTurn({ turnNumber: 5, content: "did something" })];
		const stub = generateStub({ turns });
		expect(stub).toMatch(/Use veil_history\(/);
	});

	it("matches the example stub format from spec", () => {
		const turns = [
			makeTurn({ turnNumber: 5, content: "I read auth.ts and config.ts for the auth setup" }),
			makeTurn({ turnNumber: 6, decisionSummary: "Use PKCE flow for OAuth" }),
			makeTurn({ turnNumber: 7, content: 'Completed sub-task "Understand current auth"' }),
			makeTurn({ turnNumber: 8, content: "Wrapping up the auth exploration" }),
		];
		const capturedIds = new Map([
			["turn-5", "abc123"],
			["turn-5", "def456"], // overwrite to test last value
		]);
		const stub = generateStub({ turns, capturedIds });
		expect(stub).toContain("Turns 5-8 summarized");
		expect(stub).toContain("Decided: Use PKCE flow for OAuth");
		expect(stub).toMatch(/Use veil_history\(/);
	});
});
