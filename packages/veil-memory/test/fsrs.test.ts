import { describe, expect, it } from "vitest";
import { DEFAULT_FSRS_CONFIG, FSRSEngine } from "../src/fsrs.ts";

describe("FSRSEngine", () => {
	const engine = new FSRSEngine();

	describe("computeRetrievability", () => {
		it("returns 1.0 when time since recall is 0", () => {
			expect(engine.computeRetrievability(1, 0)).toBe(1.0);
		});

		it("returns 1.0 when time is negative (clock skew)", () => {
			expect(engine.computeRetrievability(1, -1)).toBe(1.0);
		});

		it("returns 0.9 when t equals S (calibration check)", () => {
			const R = engine.computeRetrievability(1, 1);
			expect(R).toBeCloseTo(0.9, 4);
		});

		it("decays over time", () => {
			const R1 = engine.computeRetrievability(1, 0.5);
			const R2 = engine.computeRetrievability(1, 1);
			const R3 = engine.computeRetrievability(1, 2);

			expect(R1).toBeGreaterThan(R2);
			expect(R2).toBeGreaterThan(R3);
		});

		it("higher stability means slower decay", () => {
			const lowStability = engine.computeRetrievability(1, 2);
			const highStability = engine.computeRetrievability(10, 2);

			expect(highStability).toBeGreaterThan(lowStability);
		});
	});

	describe("updateStability", () => {
		it("increases stability on recall", () => {
			const oldS = 1;
			const newS = engine.updateStability(oldS, 0.5, 0.5, "factual");
			expect(newS).toBeGreaterThan(oldS);
		});

		it("increases more for surprising recalls (low R)", () => {
			const sLowR = engine.updateStability(1, 0.5, 0.3, "factual");
			const sHighR = engine.updateStability(1, 0.5, 0.9, "factual");

			expect(sLowR).toBeGreaterThan(sHighR);
		});

		it("respects type-specific caps", () => {
			const s = engine.updateStability(300, 0.3, 0.1, "episodic");
			expect(s).toBeLessThanOrEqual(DEFAULT_FSRS_CONFIG.stabilityCap.episodic);
		});

		it("does not explode stability with conservative growth", () => {
			const s = engine.updateStability(1, 0.5, 0.5, "factual");
			expect(s).toBeLessThan(10);
		});
	});

	describe("updateDifficulty", () => {
		it("increases difficulty when recall was hard", () => {
			const oldD = 0.5;
			const newD = engine.updateDifficulty(oldD, true);
			expect(newD).toBeGreaterThan(oldD);
		});

		it("decreases difficulty when recall was easy", () => {
			const oldD = 0.5;
			const newD = engine.updateDifficulty(oldD, false);
			expect(newD).toBeLessThan(oldD);
		});

		it("clamps to min/max bounds", () => {
			let d = 0.1;
			for (let i = 0; i < 50; i++) {
				d = engine.updateDifficulty(d, false);
			}
			expect(d).toBeGreaterThanOrEqual(DEFAULT_FSRS_CONFIG.minDifficulty);

			d = 0.9;
			for (let i = 0; i < 50; i++) {
				d = engine.updateDifficulty(d, true);
			}
			expect(d).toBeLessThanOrEqual(DEFAULT_FSRS_CONFIG.maxDifficulty);
		});
	});

	describe("getTier", () => {
		it("returns hot for R > 0.7", () => {
			expect(engine.getTier(0.8)).toBe("hot");
			expect(engine.getTier(0.71)).toBe("hot");
		});

		it("returns warm for 0.3 < R <= 0.7", () => {
			expect(engine.getTier(0.5)).toBe("warm");
			expect(engine.getTier(0.31)).toBe("warm");
			expect(engine.getTier(0.7)).toBe("warm");
		});

		it("returns cold for R <= 0.3", () => {
			expect(engine.getTier(0.3)).toBe("cold");
			expect(engine.getTier(0.1)).toBe("cold");
		});
	});

	describe("getInitialStability", () => {
		it("returns type-specific values", () => {
			expect(engine.getInitialStability("episodic")).toBe(0.5);
			expect(engine.getInitialStability("factual")).toBe(1);
			expect(engine.getInitialStability("procedural")).toBe(7);
		});
	});
});
