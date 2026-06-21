import { describe, expect, test } from "vitest";
import { classifyTurn, heuristicClassify, parseTurnMeta, stripTurnMeta } from "./turn-classifier.ts";

describe("parseTurnMeta", () => {
	test("parses valid block with all fields", () => {
		const response = `I'll refactor the auth module.\n\n<turn-meta>\ntype: decision\nintent: intent_003\ndecision: Use OAuth2 with PKCE flow\n</turn-meta>`;
		expect(parseTurnMeta(response)).toEqual({
			type: "decision",
			intentId: "intent_003",
			decisionSummary: "Use OAuth2 with PKCE flow",
		});
	});

	test("parses block with only type", () => {
		const response = `Done with the refactor.\n\n<turn-meta>\ntype: status\n</turn-meta>`;
		expect(parseTurnMeta(response)).toEqual({ type: "status" });
	});

	test("returns null when no block present", () => {
		expect(parseTurnMeta("Just a normal response with no metadata.")).toBeNull();
	});

	test("returns null when type field is missing", () => {
		const response = `<turn-meta>\nintent: intent_001\n</turn-meta>`;
		expect(parseTurnMeta(response)).toBeNull();
	});

	test("returns null when type is invalid", () => {
		const response = `<turn-meta>\ntype: unknown_type\n</turn-meta>`;
		expect(parseTurnMeta(response)).toBeNull();
	});

	test("parses all valid turn types", () => {
		const types = ["decision", "exploration", "action", "correction", "status", "intent"] as const;
		for (const type of types) {
			const response = `<turn-meta>\ntype: ${type}\n</turn-meta>`;
			expect(parseTurnMeta(response)?.type).toBe(type);
		}
	});
});

describe("heuristicClassify", () => {
	test("classifies decision patterns", () => {
		expect(heuristicClassify("I'll use vitest for testing", "assistant").type).toBe("decision");
		expect(heuristicClassify("let's go with the monorepo approach", "assistant").type).toBe("decision");
		expect(heuristicClassify("the approach will be incremental", "assistant").type).toBe("decision");
		expect(heuristicClassify("Decision: use TypeScript strict mode", "assistant").type).toBe("decision");
	});

	test("classifies correction patterns", () => {
		expect(heuristicClassify("No, that's not what I meant", "user").type).toBe("correction");
		expect(heuristicClassify("Actually, we should use the other approach", "user").type).toBe("correction");
		expect(heuristicClassify("Wait, let me reconsider", "user").type).toBe("correction");
		expect(heuristicClassify("That's not right, instead, we need to...", "assistant").type).toBe("correction");
	});

	test("classifies intent patterns", () => {
		expect(heuristicClassify("I want to build a memory system", "user").type).toBe("intent");
		expect(heuristicClassify("The goal is to reduce context usage", "user").type).toBe("intent");
		expect(heuristicClassify("We need to implement FSRS", "user").type).toBe("intent");
	});

	test("classifies exploration patterns", () => {
		expect(heuristicClassify("What if we used a graph instead?", "user").type).toBe("exploration");
		expect(heuristicClassify("We could try a different approach here", "assistant").type).toBe("exploration");
		expect(heuristicClassify("Another option would be sqlite-vec", "assistant").type).toBe("exploration");
	});

	test("classifies action patterns", () => {
		expect(heuristicClassify("I'll read the spec first", "assistant").type).toBe("action");
		expect(heuristicClassify("I'll write the test file now", "assistant").type).toBe("action");
		expect(heuristicClassify("Let me look at the existing code", "assistant").type).toBe("action");
		expect(heuristicClassify("Let me search for usages", "assistant").type).toBe("action");
	});

	test("classifies status patterns", () => {
		expect(heuristicClassify("Done with the implementation", "assistant").type).toBe("status");
		expect(heuristicClassify("Completed the refactor", "assistant").type).toBe("status");
		expect(heuristicClassify("Finished adding tests", "assistant").type).toBe("status");
	});

	test("defaults to intent for user messages with no signal", () => {
		expect(heuristicClassify("ok sounds good", "user").type).toBe("intent");
	});

	test("defaults to action for assistant messages with no signal", () => {
		expect(heuristicClassify("Here is the code you asked for.", "assistant").type).toBe("action");
	});
});

describe("classifyTurn", () => {
	test("uses parsed block when present", () => {
		const response = `Let me check the types.\n\n<turn-meta>\ntype: exploration\nintent: intent_005\n</turn-meta>`;
		expect(classifyTurn(response, "assistant")).toEqual({ type: "exploration", intentId: "intent_005" });
	});

	test("falls back to heuristics when no block", () => {
		expect(classifyTurn("I'll run the tests now", "assistant").type).toBe("action");
	});

	test("falls back to heuristics when block has invalid type", () => {
		const response = `<turn-meta>\ntype: bogus\n</turn-meta>`;
		expect(classifyTurn(response, "user").type).toBe("intent");
	});
});

describe("stripTurnMeta", () => {
	test("removes turn-meta block from response", () => {
		const response = `I'll refactor the auth module.\n\n<turn-meta>\ntype: decision\nintent: intent_003\n</turn-meta>`;
		expect(stripTurnMeta(response)).toBe("I'll refactor the auth module.");
	});

	test("leaves responses without a block unchanged", () => {
		const response = "Just a normal response.";
		expect(stripTurnMeta(response)).toBe("Just a normal response.");
	});

	test("handles block at start of response", () => {
		const response = `<turn-meta>\ntype: status\n</turn-meta>`;
		expect(stripTurnMeta(response)).toBe("");
	});
});
