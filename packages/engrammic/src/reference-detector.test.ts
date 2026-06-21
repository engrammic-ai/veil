import { describe, expect, test } from "vitest";
import {
	computeReferencePenalty,
	cosineSimilarity,
	isProtected,
	PROTECTED_WINDOW,
	SIMILARITY_THRESHOLD,
	type TurnWithEmbedding,
} from "./reference-detector.ts";

function vec(...values: number[]): Float32Array {
	return new Float32Array(values);
}

function makeTurn(id: string, turnNumber: number, embedding: Float32Array): TurnWithEmbedding {
	return { turnId: id, turnNumber, embedding };
}

describe("cosineSimilarity", () => {
	test("identical vectors return 1", () => {
		const a = vec(1, 0, 0);
		expect(cosineSimilarity(a, a)).toBeCloseTo(1.0);
	});

	test("orthogonal vectors return 0", () => {
		const a = vec(1, 0, 0);
		const b = vec(0, 1, 0);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
	});

	test("opposite vectors return -1", () => {
		const a = vec(1, 0, 0);
		const b = vec(-1, 0, 0);
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
	});

	test("known similarity between two vectors", () => {
		const a = vec(1, 1, 0);
		const b = vec(1, 0, 0);
		// dot=1, |a|=sqrt(2), |b|=1 → 1/sqrt(2) ≈ 0.707
		expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 4);
	});

	test("zero vectors return 0 (no divide-by-zero)", () => {
		const a = vec(0, 0, 0);
		const b = vec(1, 0, 0);
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	test("throws on dimension mismatch", () => {
		expect(() => cosineSimilarity(vec(1, 2), vec(1, 2, 3))).toThrow("Embedding dimension mismatch");
	});
});

describe("computeReferencePenalty", () => {
	test("returns 1.0 when no recent turns", () => {
		const turn = makeTurn("t1", 1, vec(1, 0, 0));
		expect(computeReferencePenalty(turn, [])).toBe(1.0);
	});

	test("returns 1.0 when max similarity is below threshold", () => {
		const turn = makeTurn("t1", 1, vec(1, 0, 0));
		const recent = [makeTurn("t2", 5, vec(0, 1, 0))]; // similarity = 0
		expect(computeReferencePenalty(turn, recent)).toBe(1.0);
	});

	test("returns 1 - maxSim when above threshold", () => {
		const turn = makeTurn("t1", 1, vec(1, 0, 0));
		// similarity = 1.0 (identical) → penalty = 0.0
		const recent = [makeTurn("t2", 5, vec(1, 0, 0))];
		expect(computeReferencePenalty(turn, recent)).toBeCloseTo(0.0);
	});

	test("picks the max similarity across multiple recent turns", () => {
		const turn = makeTurn("t1", 1, vec(1, 0, 0));
		const low = makeTurn("t2", 5, vec(0, 1, 0)); // sim = 0
		const high = makeTurn("t3", 6, vec(1, 0, 0)); // sim = 1.0
		const result = computeReferencePenalty(turn, [low, high]);
		expect(result).toBeCloseTo(0.0);
	});

	test("similarity exactly at threshold still triggers penalty", () => {
		// vec(1,1,0) vs vec(1,0,0) ≈ 0.7071 which is > SIMILARITY_THRESHOLD (0.7)
		const turn = makeTurn("t1", 1, vec(1, 1, 0));
		const recent = [makeTurn("t2", 5, vec(1, 0, 0))];
		const result = computeReferencePenalty(turn, recent);
		expect(result).toBeLessThan(1.0);
		expect(result).toBeCloseTo(1 - Math.SQRT1_2, 3);
	});
});

describe("isProtected", () => {
	test("turn is protected when age <= PROTECTED_WINDOW", () => {
		const currentTurn = 20;
		expect(isProtected(20, currentTurn)).toBe(true); // age = 0
		expect(isProtected(20 - PROTECTED_WINDOW, currentTurn)).toBe(true); // age = 12
	});

	test("turn is not protected when age > PROTECTED_WINDOW", () => {
		const currentTurn = 20;
		expect(isProtected(20 - PROTECTED_WINDOW - 1, currentTurn)).toBe(false); // age = 13
		expect(isProtected(1, currentTurn)).toBe(false); // age = 19
	});

	test("current turn is always protected", () => {
		expect(isProtected(100, 100)).toBe(true);
	});

	test("turn at exactly PROTECTED_WINDOW age is still protected", () => {
		expect(isProtected(5, 5 + PROTECTED_WINDOW)).toBe(true);
	});

	test("turn one beyond PROTECTED_WINDOW is not protected", () => {
		expect(isProtected(5, 5 + PROTECTED_WINDOW + 1)).toBe(false);
	});
});

describe("constants", () => {
	test("PROTECTED_WINDOW is 12", () => {
		expect(PROTECTED_WINDOW).toBe(12);
	});

	test("SIMILARITY_THRESHOLD is 0.7", () => {
		expect(SIMILARITY_THRESHOLD).toBe(0.7);
	});
});
