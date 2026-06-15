/**
 * Tests for Convergence Monitor — Phase D.3
 */

import { describe, expect, test } from "vitest";
import type { AttemptRecord } from "./attempts.ts";
import {
	buildConvergenceWarning,
	ConvergenceMonitor,
	type ConvergenceState,
	DEFAULT_THRESHOLDS,
	type EscalationResult,
	isProgress,
} from "./convergence.ts";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
	return {
		id: "attempt-1",
		sessionId: "session-1",
		goalId: "file:auth.ts",
		iteration: 1,
		action: "bash",
		target: "auth.ts",
		outcome: "fail",
		evidence: "TypeError: Cannot read property 'user' of undefined",
		errorPattern: "property-access-error",
		createdAt: Date.now(),
		turn: 1,
		goalOpen: true,
		pinned: false,
		...overrides,
	};
}

// ─── isProgress Tests (D.3.2) ─────────────────────────────────────────────────

describe("isProgress", () => {
	test("first attempt is always progress", () => {
		const curr = makeAttempt();
		expect(isProgress(null, curr)).toBe(true);
	});

	test("pass outcome is progress", () => {
		const prev = makeAttempt({ outcome: "fail" });
		const curr = makeAttempt({ outcome: "pass" });
		expect(isProgress(prev, curr)).toBe(true);
	});

	test("partial outcome is progress", () => {
		const prev = makeAttempt({ outcome: "fail" });
		const curr = makeAttempt({ outcome: "partial" });
		expect(isProgress(prev, curr)).toBe(true);
	});

	test("different error pattern is progress", () => {
		const prev = makeAttempt({ errorPattern: "error-a" });
		const curr = makeAttempt({ errorPattern: "error-b" });
		expect(isProgress(prev, curr)).toBe(true);
	});

	test("different target is progress", () => {
		const prev = makeAttempt({ target: "file-a.ts" });
		const curr = makeAttempt({ target: "file-b.ts" });
		expect(isProgress(prev, curr)).toBe(true);
	});

	test("same failure with same pattern is not progress", () => {
		const prev = makeAttempt({ outcome: "fail", errorPattern: "error-a", target: "file.ts" });
		const curr = makeAttempt({ outcome: "fail", errorPattern: "error-a", target: "file.ts" });
		expect(isProgress(prev, curr)).toBe(false);
	});

	test("uncertain to fail is not progress if same pattern", () => {
		const prev = makeAttempt({ outcome: "uncertain", errorPattern: "error-a" });
		const curr = makeAttempt({ outcome: "fail", errorPattern: "error-a" });
		expect(isProgress(prev, curr)).toBe(false);
	});
});

// ─── ConvergenceMonitor Tests (D.3.1, D.3.3, D.3.4) ───────────────────────────

describe("ConvergenceMonitor", () => {
	test("initializes with default thresholds", () => {
		const monitor = new ConvergenceMonitor();
		const thresholds = monitor.getThresholds();

		expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
	});

	test("accepts custom thresholds", () => {
		const monitor = new ConvergenceMonitor({ maxConsecutiveFailures: 10 });
		const thresholds = monitor.getThresholds();

		expect(thresholds.maxConsecutiveFailures).toBe(10);
		expect(thresholds.maxTotalAttempts).toBe(DEFAULT_THRESHOLDS.maxTotalAttempts);
	});

	test("creates state on first update", () => {
		const monitor = new ConvergenceMonitor();
		const attempt = makeAttempt({ goalId: "test-goal" });

		monitor.update(attempt, 1);

		const state = monitor.getState("test-goal");
		expect(state).not.toBeNull();
		expect(state?.goalId).toBe("test-goal");
		expect(state?.totalAttempts).toBe(1);
	});

	test("increments totalAttempts on each update", () => {
		const monitor = new ConvergenceMonitor();

		monitor.update(makeAttempt({ id: "a1" }), 1);
		monitor.update(makeAttempt({ id: "a2" }), 2);
		monitor.update(makeAttempt({ id: "a3" }), 3);

		const state = monitor.getState("file:auth.ts");
		expect(state?.totalAttempts).toBe(3);
	});

	test("tracks consecutive failures", () => {
		const monitor = new ConvergenceMonitor();

		monitor.update(makeAttempt({ id: "a1", outcome: "fail" }), 1);
		monitor.update(makeAttempt({ id: "a2", outcome: "fail" }), 2);

		let state = monitor.getState("file:auth.ts");
		expect(state?.consecutiveFailures).toBe(2);

		monitor.update(makeAttempt({ id: "a3", outcome: "pass" }), 3);

		state = monitor.getState("file:auth.ts");
		expect(state?.consecutiveFailures).toBe(0);
	});

	test("tracks turns without progress", () => {
		const monitor = new ConvergenceMonitor();

		monitor.update(makeAttempt({ id: "a1", errorPattern: "err-a" }), 1);
		monitor.update(makeAttempt({ id: "a2", errorPattern: "err-a" }), 5);

		const state = monitor.getState("file:auth.ts");
		expect(state?.turnsWithoutProgress).toBe(4);
	});

	test("resets turnsWithoutProgress on progress", () => {
		const monitor = new ConvergenceMonitor();

		monitor.update(makeAttempt({ id: "a1", errorPattern: "err-a" }), 1);
		monitor.update(makeAttempt({ id: "a2", errorPattern: "err-a" }), 5);
		monitor.update(makeAttempt({ id: "a3", errorPattern: "err-b" }), 6);

		const state = monitor.getState("file:auth.ts");
		expect(state?.turnsWithoutProgress).toBe(0);
		expect(state?.lastProgressTurn).toBe(6);
	});

	test("returns null for unknown goal", () => {
		const monitor = new ConvergenceMonitor();
		expect(monitor.getState("unknown")).toBeNull();
	});

	test("resetGoal clears state", () => {
		const monitor = new ConvergenceMonitor();
		monitor.update(makeAttempt(), 1);

		monitor.resetGoal("file:auth.ts");

		expect(monitor.getState("file:auth.ts")).toBeNull();
	});

	test("getAllStates returns all tracked goals", () => {
		const monitor = new ConvergenceMonitor();

		monitor.update(makeAttempt({ goalId: "goal-a" }), 1);
		monitor.update(makeAttempt({ goalId: "goal-b" }), 2);

		const states = monitor.getAllStates();
		expect(states).toHaveLength(2);
		expect(states.map((s) => s.goalId).sort()).toEqual(["goal-a", "goal-b"]);
	});
});

// ─── Escalation Tests (D.3.3, D.3.5-D.3.7) ────────────────────────────────────

describe("checkConvergence escalation", () => {
	test("returns level 0 when under all thresholds", () => {
		const monitor = new ConvergenceMonitor();
		const attempt = makeAttempt();

		const result = monitor.update(attempt, 1);

		expect(result.level).toBe(0);
	});

	test("returns level 1 on repeated error pattern", () => {
		const monitor = new ConvergenceMonitor({ escalateOnRepeat: 3 });

		monitor.recordPattern("file:auth.ts", "same-error");
		monitor.recordPattern("file:auth.ts", "same-error");

		const attempt = makeAttempt({ errorPattern: "same-error" });
		monitor.recordPattern("file:auth.ts", "same-error");

		const state = monitor.getState("file:auth.ts") ?? {
			goalId: "file:auth.ts",
			totalAttempts: 3,
			consecutiveFailures: 3,
			uniqueApproaches: 1,
			lastProgressTurn: 1,
			turnsWithoutProgress: 0,
			lastAttempt: null,
		};

		const result = monitor.checkConvergence(state, attempt);
		expect(result.level).toBe(1);
		expect(result.reason).toContain("repeated");
	});

	test("returns level 2 on consecutive failures threshold", () => {
		const monitor = new ConvergenceMonitor({ maxConsecutiveFailures: 3 });

		monitor.update(makeAttempt({ id: "a1" }), 1);
		monitor.update(makeAttempt({ id: "a2" }), 2);
		const result = monitor.update(makeAttempt({ id: "a3" }), 3);

		expect(result.level).toBe(2);
		expect(result.reason).toContain("consecutive failures");
	});

	test("returns level 3 on total attempts threshold", () => {
		const monitor = new ConvergenceMonitor({ maxTotalAttempts: 5 });

		for (let i = 1; i < 5; i++) {
			monitor.update(makeAttempt({ id: `a${i}`, errorPattern: `err-${i}` }), i);
		}

		const result = monitor.update(makeAttempt({ id: "a5", errorPattern: "err-5" }), 5);

		expect(result.level).toBe(3);
		expect(result.reason).toContain("total attempts");
	});

	test("returns level 3 on turns without progress threshold", () => {
		const monitor = new ConvergenceMonitor({ maxTurnsWithoutProgress: 5 });

		monitor.update(makeAttempt({ id: "a1", errorPattern: "err" }), 1);
		const result = monitor.update(makeAttempt({ id: "a2", errorPattern: "err" }), 7);

		expect(result.level).toBe(3);
		expect(result.reason).toContain("No progress");
	});

	test("higher levels take precedence over lower", () => {
		const monitor = new ConvergenceMonitor({
			maxConsecutiveFailures: 2,
			maxTotalAttempts: 3,
		});

		monitor.update(makeAttempt({ id: "a1" }), 1);
		monitor.update(makeAttempt({ id: "a2" }), 2);
		const result = monitor.update(makeAttempt({ id: "a3" }), 3);

		expect(result.level).toBe(3);
	});
});

// ─── Warning Message Tests (D.3.5) ────────────────────────────────────────────

describe("buildConvergenceWarning", () => {
	const baseState: ConvergenceState = {
		goalId: "file:auth.ts",
		totalAttempts: 5,
		consecutiveFailures: 3,
		uniqueApproaches: 2,
		lastProgressTurn: 1,
		turnsWithoutProgress: 4,
		lastAttempt: null,
	};

	test("returns empty string for level 0", () => {
		const result: EscalationResult = { level: 0 };
		expect(buildConvergenceWarning(baseState, result)).toBe("");
	});

	test("includes warning header for level 1", () => {
		const result: EscalationResult = { level: 1, reason: "Same error repeated 3 times" };
		const warning = buildConvergenceWarning(baseState, result);

		expect(warning).toContain("[CONVERGENCE WARNING]");
		expect(warning).toContain("Same error repeated");
	});

	test("includes suggestion for level 2", () => {
		const result: EscalationResult = { level: 2, reason: "5 consecutive failures" };
		const warning = buildConvergenceWarning(baseState, result);

		expect(warning).toContain("different approach");
		expect(warning).toContain("asking for help");
	});

	test("includes halt recommendation for level 3", () => {
		const result: EscalationResult = { level: 3, reason: "15 total attempts" };
		const warning = buildConvergenceWarning(baseState, result);

		expect(warning).toContain("[HALT RECOMMENDED]");
		expect(warning).toContain("Manual intervention");
	});

	test("includes stats in all warnings", () => {
		const result: EscalationResult = { level: 1, reason: "test" };
		const warning = buildConvergenceWarning(baseState, result);

		expect(warning).toContain("5 attempts");
		expect(warning).toContain("3 consecutive failures");
		expect(warning).toContain("2 unique approaches");
	});
});

// ─── Threshold Configuration Tests (D.3.9) ────────────────────────────────────

describe("threshold configuration", () => {
	test("setThresholds updates at runtime", () => {
		const monitor = new ConvergenceMonitor();

		monitor.setThresholds({ maxConsecutiveFailures: 20 });

		const thresholds = monitor.getThresholds();
		expect(thresholds.maxConsecutiveFailures).toBe(20);
		expect(thresholds.maxTotalAttempts).toBe(DEFAULT_THRESHOLDS.maxTotalAttempts);
	});

	test("partial threshold update preserves others", () => {
		const monitor = new ConvergenceMonitor({ maxTotalAttempts: 100 });

		monitor.setThresholds({ escalateOnRepeat: 5 });

		const thresholds = monitor.getThresholds();
		expect(thresholds.maxTotalAttempts).toBe(100);
		expect(thresholds.escalateOnRepeat).toBe(5);
	});
});
