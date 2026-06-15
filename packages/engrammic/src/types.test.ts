import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "./types.ts";

describe("DEFAULT_CONFIG autonomic fields", () => {
	test("includes self-tuning defaults", () => {
		expect(DEFAULT_CONFIG.reRequestBackoffStep).toBe(0.05);
		expect(DEFAULT_CONFIG.reRequestWindowMs).toBe(30 * 60 * 1000);
		expect(DEFAULT_CONFIG.decaySweepIntervalTurns).toBe(50);
	});
});
