import { describe, expect, test } from "vitest";
import type { EvictionCandidate, EvictionNotifyConfig } from "./types.ts";
import { formatBox, formatEvictionNotification, formatProgressBar, formatStatusBar, getHealthColor } from "./ux.ts";

describe("getHealthColor", () => {
	test("returns success for < 50%", () => {
		expect(getHealthColor(0)).toBe("success");
		expect(getHealthColor(25)).toBe("success");
		expect(getHealthColor(49)).toBe("success");
	});

	test("returns warning for 50-70%", () => {
		expect(getHealthColor(50)).toBe("warning");
		expect(getHealthColor(60)).toBe("warning");
		expect(getHealthColor(69)).toBe("warning");
	});

	test("returns accent for 70-85%", () => {
		expect(getHealthColor(70)).toBe("accent");
		expect(getHealthColor(80)).toBe("accent");
		expect(getHealthColor(84)).toBe("accent");
	});

	test("returns error for >= 85%", () => {
		expect(getHealthColor(85)).toBe("error");
		expect(getHealthColor(90)).toBe("error");
		expect(getHealthColor(100)).toBe("error");
	});
});

describe("formatProgressBar", () => {
	test("renders empty bar at 0%", () => {
		expect(formatProgressBar(0, 20)).toBe("....................");
	});

	test("renders full bar at 100%", () => {
		expect(formatProgressBar(100, 20)).toBe("====================");
	});

	test("renders partial bar at 50%", () => {
		expect(formatProgressBar(50, 20)).toBe("==========..........");
	});

	test("handles width of 10", () => {
		expect(formatProgressBar(30, 10)).toBe("===.......");
	});
});

describe("formatBox", () => {
	test("renders box with title", () => {
		const lines = formatBox(["Line 1", "Line 2"], "Test", 30);
		expect(lines[0]).toBe("+-- Test ---------------------+");
		expect(lines[1]).toContain("Line 1");
		expect(lines[2]).toContain("Line 2");
		expect(lines[3]).toMatch(/^\+-+\+$/);
	});

	test("renders box without title", () => {
		const lines = formatBox(["Hello"], undefined, 20);
		expect(lines[0]).toBe("+------------------+");
		expect(lines[1]).toContain("Hello");
		expect(lines[2]).toBe("+------------------+");
	});

	test("handles empty content", () => {
		const lines = formatBox([], "Empty", 20);
		expect(lines.length).toBe(2);
	});
});

describe("formatStatusBar", () => {
	test("formats status with tokens and color", () => {
		const result = formatStatusBar(2100, 8000);
		expect(result.text).toBe("Context: 2.1k/8k");
		expect(result.color).toBe("success");
	});

	test("returns warning color at 60%", () => {
		const result = formatStatusBar(4800, 8000);
		expect(result.color).toBe("warning");
	});

	test("returns error color at 90%", () => {
		const result = formatStatusBar(7200, 8000);
		expect(result.color).toBe("error");
	});
});

function makeEvicted(count: number): EvictionCandidate[] {
	return Array.from({ length: count }, (_, i) => ({
		item: {
			id: `item-${i}`,
			content: `Content for item ${i}`,
			contentHash: `hash-${i}`,
			createdAt: Date.now(),
			lastAccess: Date.now(),
			accessCount: 1,
			decayScore: 0.5,
			cognitiveWeight: 0,
			type: "fact" as const,
			tags: [`tag-${i}`],
			pinned: false,
			source: "auto" as const,
		},
		score: 0.3,
		reason: "low_score" as const,
	}));
}

describe("formatEvictionNotification", () => {
	test("returns null when disabled", () => {
		const config: EvictionNotifyConfig = { enabled: false, minItems: 1, verbosity: "minimal" };
		const result = formatEvictionNotification(makeEvicted(3), config);
		expect(result).toBeNull();
	});

	test("returns null when below minItems", () => {
		const config: EvictionNotifyConfig = { enabled: true, minItems: 5, verbosity: "minimal" };
		const result = formatEvictionNotification(makeEvicted(3), config);
		expect(result).toBeNull();
	});

	test("minimal verbosity shows count only", () => {
		const config: EvictionNotifyConfig = { enabled: true, minItems: 1, verbosity: "minimal" };
		const result = formatEvictionNotification(makeEvicted(3), config);
		expect(result).toBe("Evicted 3 items");
	});

	test("standard verbosity shows item summaries", () => {
		const config: EvictionNotifyConfig = { enabled: true, minItems: 1, verbosity: "standard" };
		const result = formatEvictionNotification(makeEvicted(2), config);
		expect(result).toContain("Evicted 2 items");
		expect(result).toContain("Content for item 0");
	});

	test("verbose shows token counts", () => {
		const config: EvictionNotifyConfig = { enabled: true, minItems: 1, verbosity: "verbose" };
		const result = formatEvictionNotification(makeEvicted(2), config);
		expect(result).toContain("to free");
		expect(result).toContain("tokens");
	});
});
