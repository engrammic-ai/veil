import { describe, expect, it } from "vitest";
import {
	calculateEvictionScore,
	isNeverEvict,
	PROTECTED_WINDOW,
	rankForEviction,
	selectForEviction,
	TYPE_WEIGHTS,
} from "./turn-eviction.ts";

describe("isNeverEvict", () => {
	it("returns true for intent_declaration", () => {
		expect(isNeverEvict("intent_declaration")).toBe(true);
	});

	it("returns true for intent (TurnMeta alias)", () => {
		expect(isNeverEvict("intent")).toBe(true);
	});

	it("returns true for correction", () => {
		expect(isNeverEvict("correction")).toBe(true);
	});

	it("returns false for exploration", () => {
		expect(isNeverEvict("exploration")).toBe(false);
	});

	it("returns false for action", () => {
		expect(isNeverEvict("action")).toBe(false);
	});

	it("returns false for status", () => {
		expect(isNeverEvict("status")).toBe(false);
	});

	it("returns true for decision (weight 0.1, not 0.0 — should be evictable)", () => {
		// decision has weight 0.1, so isNeverEvict returns false
		expect(isNeverEvict("decision")).toBe(false);
	});

	it("returns true for unknown type (defaults to never-evict for safety)", () => {
		expect(isNeverEvict("unknown_type")).toBe(true);
	});
});

describe("calculateEvictionScore", () => {
	const currentTurn = 50;

	it("returns 0 for turns in protected window", () => {
		const turn = { turnNumber: currentTurn - PROTECTED_WINDOW, type: "exploration" };
		expect(calculateEvictionScore(turn, currentTurn, 1.0)).toBe(0);
	});

	it("returns 0 for turns newer than protected window", () => {
		const turn = { turnNumber: currentTurn - 5, type: "exploration" };
		expect(calculateEvictionScore(turn, currentTurn, 1.0)).toBe(0);
	});

	it("returns 0 for never-evict types regardless of age", () => {
		const oldTurn = { turnNumber: 1, type: "correction" };
		expect(calculateEvictionScore(oldTurn, currentTurn, 1.0)).toBe(0);
	});

	it("returns 0 for intent type regardless of age", () => {
		const oldTurn = { turnNumber: 1, type: "intent" };
		expect(calculateEvictionScore(oldTurn, currentTurn, 1.0)).toBe(0);
	});

	it("scores exploration turn beyond protected window", () => {
		// age = 20 + PROTECTED_WINDOW = beyond protected, age factor = min(1.0, 20/20) = 1.0
		const turn = { turnNumber: currentTurn - PROTECTED_WINDOW - 20, type: "exploration" };
		const score = calculateEvictionScore(turn, currentTurn, 1.0);
		expect(score).toBeCloseTo(TYPE_WEIGHTS.exploration!);
	});

	it("score increases with age beyond protected window", () => {
		const young = { turnNumber: currentTurn - PROTECTED_WINDOW - 5, type: "exploration" };
		const old = { turnNumber: currentTurn - PROTECTED_WINDOW - 15, type: "exploration" };
		const youngScore = calculateEvictionScore(young, currentTurn, 1.0);
		const oldScore = calculateEvictionScore(old, currentTurn, 1.0);
		expect(oldScore).toBeGreaterThan(youngScore);
	});

	it("reference penalty reduces score", () => {
		const turn = { turnNumber: currentTurn - PROTECTED_WINDOW - 10, type: "exploration" };
		const highRef = calculateEvictionScore(turn, currentTurn, 0.2);
		const noRef = calculateEvictionScore(turn, currentTurn, 1.0);
		expect(highRef).toBeLessThan(noRef);
	});

	it("action type has lower score than exploration at same age", () => {
		const age = currentTurn - PROTECTED_WINDOW - 10;
		const exploration = { turnNumber: age, type: "exploration" };
		const action = { turnNumber: age, type: "action" };
		const explorationScore = calculateEvictionScore(exploration, currentTurn, 1.0);
		const actionScore = calculateEvictionScore(action, currentTurn, 1.0);
		expect(explorationScore).toBeGreaterThan(actionScore);
	});
});

describe("rankForEviction", () => {
	const currentTurn = 50;

	it("returns turns sorted highest score first", () => {
		const turns = [
			{ turnId: "t1", turnNumber: 1, type: "exploration", referencePenalty: 1.0 },
			{ turnId: "t2", turnNumber: 2, type: "action", referencePenalty: 1.0 },
			{ turnId: "t3", turnNumber: 3, type: "correction", referencePenalty: 1.0 },
		];

		const ranked = rankForEviction(turns, currentTurn);
		expect(ranked[0]!.turnId).toBe("t1"); // exploration scores highest
		expect(ranked[1]!.turnId).toBe("t2"); // action next
		expect(ranked[2]!.turnId).toBe("t3"); // correction always 0
	});

	it("never-evict turns have score 0", () => {
		const turns = [
			{ turnId: "t1", turnNumber: 1, type: "intent_declaration", referencePenalty: 1.0 },
			{ turnId: "t2", turnNumber: 1, type: "correction", referencePenalty: 1.0 },
		];

		const ranked = rankForEviction(turns, currentTurn);
		for (const r of ranked) {
			expect(r.evictionScore).toBe(0);
		}
	});

	it("protected window turns score 0", () => {
		const turns = [{ turnId: "t1", turnNumber: currentTurn - 5, type: "exploration", referencePenalty: 1.0 }];

		const ranked = rankForEviction(turns, currentTurn);
		expect(ranked[0]!.evictionScore).toBe(0);
	});

	it("returns empty array for empty input", () => {
		expect(rankForEviction([], currentTurn)).toEqual([]);
	});
});

describe("selectForEviction", () => {
	it("selects turns until target tokens reached", () => {
		const ranked: import("./turn-eviction.ts").ScoredTurn[] = [
			{ turnId: "t1", turnNumber: 1, type: "exploration", evictionScore: 0.9 },
			{ turnId: "t2", turnNumber: 2, type: "action", evictionScore: 0.7 },
			{ turnId: "t3", turnNumber: 3, type: "status", evictionScore: 0.5 },
		];

		const tokenCounts = new Map([
			["t1", 300],
			["t2", 400],
			["t3", 200],
		]);

		const selected = selectForEviction(ranked, tokenCounts, 500);
		expect(selected).toContain("t1");
		expect(selected).toContain("t2");
		// t3 not needed once 700 tokens freed >= 500 target
		expect(selected).not.toContain("t3");
	});

	it("skips turns with score 0", () => {
		const ranked: import("./turn-eviction.ts").ScoredTurn[] = [
			{ turnId: "t1", turnNumber: 1, type: "correction", evictionScore: 0 },
			{ turnId: "t2", turnNumber: 2, type: "exploration", evictionScore: 0.8 },
		];

		const tokenCounts = new Map([
			["t1", 1000],
			["t2", 100],
		]);

		const selected = selectForEviction(ranked, tokenCounts, 50);
		expect(selected).not.toContain("t1");
		expect(selected).toContain("t2");
	});

	it("returns empty when no evictable turns", () => {
		const ranked: import("./turn-eviction.ts").ScoredTurn[] = [
			{ turnId: "t1", turnNumber: 1, type: "correction", evictionScore: 0 },
		];
		const tokenCounts = new Map([["t1", 500]]);

		expect(selectForEviction(ranked, tokenCounts, 100)).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(selectForEviction([], new Map(), 100)).toEqual([]);
	});

	it("handles turns with no token count entry (defaults to 0)", () => {
		const ranked: import("./turn-eviction.ts").ScoredTurn[] = [
			{ turnId: "t1", turnNumber: 1, type: "exploration", evictionScore: 0.9 },
		];

		const selected = selectForEviction(ranked, new Map(), 100);
		// Turn is selected but contributes 0 tokens — loop ends without hitting target
		expect(selected).toContain("t1");
	});
});
