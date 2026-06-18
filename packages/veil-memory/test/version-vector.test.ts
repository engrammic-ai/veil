import { describe, expect, it } from "vitest";
import { areConcurrent, compare, dominates, increment, isEmpty, merge } from "../src/version-vector.ts";

describe("version-vector", () => {
	describe("dominates", () => {
		it("returns true when v1 strictly dominates v2", () => {
			expect(dominates({ a: 2 }, { a: 1 })).toBe(true);
			expect(dominates({ a: 2, b: 1 }, { a: 1, b: 1 })).toBe(true);
		});

		it("returns false when v2 dominates v1", () => {
			expect(dominates({ a: 1 }, { a: 2 })).toBe(false);
		});

		it("returns false when neither dominates (concurrent)", () => {
			expect(dominates({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe(false);
		});

		it("returns false when equal", () => {
			expect(dominates({ a: 1 }, { a: 1 })).toBe(false);
		});

		it("handles missing keys as 0", () => {
			expect(dominates({ a: 1, b: 1 }, { a: 1 })).toBe(true);
			expect(dominates({ a: 1 }, { a: 1, b: 1 })).toBe(false);
		});
	});

	describe("merge", () => {
		it("takes max of each key", () => {
			const result = merge({ a: 2, b: 1 }, { a: 1, b: 3 });
			expect(result).toEqual({ a: 2, b: 3 });
		});

		it("includes keys from both vectors", () => {
			const result = merge({ a: 1 }, { b: 2 });
			expect(result).toEqual({ a: 1, b: 2 });
		});
	});

	describe("increment", () => {
		it("increments existing key", () => {
			const result = increment({ a: 1 }, "a");
			expect(result).toEqual({ a: 2 });
		});

		it("adds new key starting at 1", () => {
			const result = increment({ a: 1 }, "b");
			expect(result).toEqual({ a: 1, b: 1 });
		});

		it("does not mutate original", () => {
			const original = { a: 1 };
			increment(original, "a");
			expect(original).toEqual({ a: 1 });
		});
	});

	describe("areConcurrent", () => {
		it("returns true when neither dominates", () => {
			expect(areConcurrent({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe(true);
		});

		it("returns false when one dominates", () => {
			expect(areConcurrent({ a: 2 }, { a: 1 })).toBe(false);
			expect(areConcurrent({ a: 1 }, { a: 2 })).toBe(false);
		});
	});

	describe("isEmpty", () => {
		it("returns true for empty object", () => {
			expect(isEmpty({})).toBe(true);
		});

		it("returns false for non-empty", () => {
			expect(isEmpty({ a: 1 })).toBe(false);
		});
	});

	describe("compare", () => {
		it("returns 1 when v1 dominates v2", () => {
			expect(compare({ a: 2 }, { a: 1 })).toBe(1);
		});

		it("returns -1 when v2 dominates v1", () => {
			expect(compare({ a: 1 }, { a: 2 })).toBe(-1);
		});

		it("returns 0 when concurrent", () => {
			expect(compare({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe(0);
		});
	});
});
