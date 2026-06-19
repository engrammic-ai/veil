import { describe, expect, test } from "vitest";
import { DEFAULT_FSRS_CONFIG, FSRSEngine } from "./fsrs.ts";

describe("FSRSEngine", () => {
	describe("computeRetrievability", () => {
		test("returns 1.0 for freshly accessed items", () => {
			const fsrs = new FSRSEngine();
			expect(fsrs.computeRetrievability(1.0, 0)).toBe(1.0);
			expect(fsrs.computeRetrievability(0.5, 0)).toBe(1.0);
		});

		test("retrievability decreases over time", () => {
			const fsrs = new FSRSEngine();
			const stability = 1.0; // 1 day stability

			const r0 = fsrs.computeRetrievability(stability, 0);
			const r1 = fsrs.computeRetrievability(stability, 0.5); // half day
			const r2 = fsrs.computeRetrievability(stability, 1.0); // 1 day

			expect(r0).toBe(1.0);
			expect(r1).toBeLessThan(r0);
			expect(r2).toBeLessThan(r1);
		});

		test("higher stability means slower decay", () => {
			const fsrs = new FSRSEngine();
			const daysSinceAccess = 1.0;

			const lowStabilityR = fsrs.computeRetrievability(0.5, daysSinceAccess);
			const highStabilityR = fsrs.computeRetrievability(2.0, daysSinceAccess);

			expect(highStabilityR).toBeGreaterThan(lowStabilityR);
		});

		test("at t=S, retrievability is approximately 0.9", () => {
			const fsrs = new FSRSEngine();
			const stability = 1.0;
			const r = fsrs.computeRetrievability(stability, stability);
			expect(r).toBeCloseTo(0.9, 1);
		});
	});

	describe("updateStability", () => {
		test("stability increases after successful recall", () => {
			const fsrs = new FSRSEngine();
			const oldStability = 0.5;
			const difficulty = 0.5;
			const retrievability = 0.7; // recalled when still rememberable

			const newStability = fsrs.updateStability(oldStability, difficulty, retrievability, "episodic");
			expect(newStability).toBeGreaterThan(oldStability);
		});

		test("recalling at low retrievability gives bigger stability boost", () => {
			const fsrs = new FSRSEngine();
			const oldStability = 0.5;
			const difficulty = 0.5;

			const boostHighR = fsrs.updateStability(oldStability, difficulty, 0.9, "episodic");
			const boostLowR = fsrs.updateStability(oldStability, difficulty, 0.3, "episodic");

			expect(boostLowR).toBeGreaterThan(boostHighR);
		});

		test("stability is capped by item type", () => {
			const fsrs = new FSRSEngine();
			const veryHighStability = 100;
			const difficulty = 0.5;
			const retrievability = 0.5;

			const episodicS = fsrs.updateStability(veryHighStability, difficulty, retrievability, "episodic");
			const proceduralS = fsrs.updateStability(veryHighStability, difficulty, retrievability, "procedural");

			expect(episodicS).toBeLessThanOrEqual(DEFAULT_FSRS_CONFIG.stabilityCap.episodic);
			expect(proceduralS).toBeLessThanOrEqual(DEFAULT_FSRS_CONFIG.stabilityCap.procedural);
		});
	});

	describe("getInitialStability", () => {
		test("returns type-specific initial stability", () => {
			const fsrs = new FSRSEngine();

			expect(fsrs.getInitialStability("episodic")).toBe(DEFAULT_FSRS_CONFIG.initialStability.episodic);
			expect(fsrs.getInitialStability("procedural")).toBe(DEFAULT_FSRS_CONFIG.initialStability.procedural);
			expect(fsrs.getInitialStability("fact")).toBe(DEFAULT_FSRS_CONFIG.initialStability.fact);
			expect(fsrs.getInitialStability("decision")).toBe(DEFAULT_FSRS_CONFIG.initialStability.decision);
		});

		test("procedural items have higher initial stability than episodic", () => {
			const fsrs = new FSRSEngine();
			expect(fsrs.getInitialStability("procedural")).toBeGreaterThan(fsrs.getInitialStability("episodic"));
		});
	});

	describe("shouldEvict", () => {
		test("returns true for low retrievability", () => {
			const fsrs = new FSRSEngine();
			expect(fsrs.shouldEvict(0.05)).toBe(true);
			expect(fsrs.shouldEvict(0.01)).toBe(true);
		});

		test("returns false for high retrievability", () => {
			const fsrs = new FSRSEngine();
			expect(fsrs.shouldEvict(0.9)).toBe(false);
			expect(fsrs.shouldEvict(0.5)).toBe(false);
			expect(fsrs.shouldEvict(0.11)).toBe(false);
		});

		test("threshold is at 0.1", () => {
			const fsrs = new FSRSEngine();
			expect(fsrs.shouldEvict(0.1)).toBe(false);
			expect(fsrs.shouldEvict(0.09)).toBe(true);
		});
	});

	describe("daysSince", () => {
		test("converts milliseconds to days", () => {
			const fsrs = new FSRSEngine();
			const now = Date.now();
			const oneDayAgo = now - 24 * 60 * 60 * 1000;

			expect(fsrs.daysSince(oneDayAgo, now)).toBeCloseTo(1.0, 2);
		});

		test("returns 0 for current time", () => {
			const fsrs = new FSRSEngine();
			const now = Date.now();
			expect(fsrs.daysSince(now, now)).toBe(0);
		});
	});
});
