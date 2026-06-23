/**
 * Multi-turn scenario tests for VeilHarness.
 *
 * These tests simulate realistic agent behavior (retry loops, multi-file edits,
 * convergence escalation) using the subscribeToEvents / mock-emitter pattern
 * established in harness.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockColdStore } from "./cold/mock.ts";
import type { ConvergenceState, EscalationResult } from "./convergence.ts";
import type { ToolResultEvent, VeilHarnessConfig } from "./harness.ts";
import { VeilHarness } from "./harness.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "veil-scenario-"));
}

function makeHarness(tmpDir: string, extra: VeilHarnessConfig = {}): VeilHarness {
	return new VeilHarness({
		dbPath: join(tmpDir, "context.db"),
		coldStore: new MockColdStore(),
		sessionId: "scenario-session",
		...extra,
	});
}

/**
 * Build a mock agentHarness event emitter compatible with subscribeToEvents().
 * Returns the mock harness and a typed emit function.
 */
function makeMockEmitter() {
	const handlers: Array<(event: ToolResultEvent) => void> = [];
	const mockAgentHarness = {
		on: (_type: "tool_result", handler: (event: ToolResultEvent) => void) => {
			handlers.push(handler);
			return () => {
				const idx = handlers.indexOf(handler);
				if (idx !== -1) handlers.splice(idx, 1);
			};
		},
	};
	const emit = (event: ToolResultEvent) => {
		for (const h of handlers) h(event);
	};
	return { mockAgentHarness, emit };
}

// ---------------------------------------------------------------------------
// Scenario 1: Retry-then-succeed flow
// ---------------------------------------------------------------------------

describe("Scenario 1: Retry-then-succeed flow", () => {
	let tmpDir: string;
	let harness: VeilHarness;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		harness = makeHarness(tmpDir);
	});

	afterEach(async () => {
		await harness.close();
		rmSync(tmpDir, { recursive: true });
	});

	it("records 2 failed attempts and 1 success across 3 turns", () => {
		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		// Turn 1 — test fails
		emit({
			toolName: "Bash",
			toolCallId: "tc-1",
			input: { command: "vitest run foo.spec.ts" },
			content: [{ type: "text", text: "FAIL foo.spec.ts > should pass\nError: expected 1 to equal 2" }],
			isError: true,
		});

		// Turn 2 — same test fails again
		emit({
			toolName: "Bash",
			toolCallId: "tc-2",
			input: { command: "vitest run foo.spec.ts" },
			content: [{ type: "text", text: "FAIL foo.spec.ts > should pass\nError: expected 1 to equal 2" }],
			isError: true,
		});

		// Turn 3 — test finally succeeds
		emit({
			toolName: "Bash",
			toolCallId: "tc-3",
			input: { command: "vitest run foo.spec.ts" },
			content: [{ type: "text", text: "PASS foo.spec.ts (1 test)" }],
			isError: false,
		});

		const store = harness.getAttemptStore();
		const allAttempts = store.getBySession("scenario-session");

		// 2 failures recorded (successes are not stored as attempt records)
		const failures = allAttempts.filter((a) => a.outcome === "fail" || a.outcome === "uncertain");
		expect(failures.length).toBe(2);

		// All attempts reference the same goal
		const goalIds = new Set(allAttempts.map((a) => a.goalId));
		expect(goalIds.size).toBe(1);
		expect([...goalIds][0]).toMatch(/foo\.spec\.ts/);
	});

	it("convergence monitor tracked consecutive failures before success", () => {
		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		// Two failures
		for (let turn = 1; turn <= 2; turn++) {
			emit({
				toolName: "Bash",
				toolCallId: `tc-${turn}`,
				input: { command: "vitest run foo.spec.ts" },
				content: [{ type: "text", text: "FAIL foo.spec.ts\nError: assertion failed" }],
				isError: true,
			});
		}

		// Check convergence state shows 2 consecutive failures
		const convState = harness.getConvergenceState("test:foo.spec.ts");
		expect(convState).not.toBeNull();
		expect(convState!.consecutiveFailures).toBe(2);

		// Now succeed — goal should be advanced
		emit({
			toolName: "Bash",
			toolCallId: "tc-3",
			input: { command: "vitest run foo.spec.ts" },
			content: [{ type: "text", text: "PASS foo.spec.ts" }],
			isError: false,
		});

		// Goal state should have been updated (currentGoalId still set after success)
		const goalState = harness.getGoalState();
		expect(goalState.currentGoalId).toBe("test:foo.spec.ts");
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: Goal merging — files in the same directory
// ---------------------------------------------------------------------------

describe("Scenario 2: Goal merging for reads of files in the same directory", () => {
	let tmpDir: string;
	let harness: VeilHarness;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		harness = makeHarness(tmpDir);
	});

	afterEach(async () => {
		await harness.close();
		rmSync(tmpDir, { recursive: true });
	});

	it("merges reads of files in the same directory under one goal", () => {
		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		// Read login.ts — this establishes the first goal
		emit({
			toolName: "Bash",
			toolCallId: "tc-1",
			input: { command: "cat /src/auth/login.ts" },
			content: [{ type: "text", text: "Error: login function missing return" }],
			isError: true,
		});

		const goalAfterFirst = harness.getGoalState().currentGoalId;

		// Read logout.ts in same /src/auth/ directory — should merge
		emit({
			toolName: "Bash",
			toolCallId: "tc-2",
			input: { command: "cat /src/auth/logout.ts" },
			content: [{ type: "text", text: "Error: logout function missing return" }],
			isError: true,
		});

		const goalAfterSecond = harness.getGoalState().currentGoalId;

		// Both reads should be under the same goal
		expect(goalAfterFirst).not.toBeNull();
		expect(goalAfterSecond).toBe(goalAfterFirst);
	});

	it("keeps attempts from both files under the merged goal", () => {
		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		emit({
			toolName: "Bash",
			toolCallId: "tc-1",
			input: { command: "cat /src/auth/login.ts" },
			content: [{ type: "text", text: "Error: login module failed" }],
			isError: true,
		});

		emit({
			toolName: "Bash",
			toolCallId: "tc-2",
			input: { command: "cat /src/auth/logout.ts" },
			content: [{ type: "text", text: "Error: logout module failed" }],
			isError: true,
		});

		const store = harness.getAttemptStore();
		const goalId = harness.getGoalState().currentGoalId!;
		expect(goalId).not.toBeNull();

		const attempts = store.getByGoal(goalId);
		expect(attempts.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: Convergence escalation
// ---------------------------------------------------------------------------

describe("Scenario 3: Convergence escalation on repeated failures", () => {
	it("fires onConvergenceWarning callback when threshold is breached", async () => {
		const warnings: Array<{ state: ConvergenceState; result: EscalationResult }> = [];
		const testDir = makeTmpDir();

		const harness = makeHarness(testDir, {
			convergenceThresholds: { maxConsecutiveFailures: 3 },
			onConvergenceWarning: (state: ConvergenceState, result: EscalationResult) => {
				warnings.push({ state, result });
			},
		});

		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		try {
			// Send 4 consecutive failures for the same goal
			for (let i = 1; i <= 4; i++) {
				emit({
					toolName: "Bash",
					toolCallId: `tc-${i}`,
					input: { command: "vitest run broken.spec.ts" },
					content: [{ type: "text", text: `FAIL broken.spec.ts\nError: assertion failed (attempt ${i})` }],
					isError: true,
				});
			}

			// The callback must have been fired at least once
			expect(warnings.length).toBeGreaterThanOrEqual(1);

			// The escalation level must be >= 2 (as required by the task)
			const maxLevel = Math.max(...warnings.map((w) => w.result.level));
			expect(maxLevel).toBeGreaterThanOrEqual(2);

			// State reported in callback matches the goal
			expect(warnings[0].state.goalId).toBe("test:broken.spec.ts");
		} finally {
			await harness.close();
			rmSync(testDir, { recursive: true });
		}
	});

	it("convergence state reflects consecutive failure count", async () => {
		const testDir = makeTmpDir();
		const harness = makeHarness(testDir, {
			convergenceThresholds: { maxConsecutiveFailures: 3 },
		});

		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		try {
			// 3 failures
			for (let i = 1; i <= 3; i++) {
				emit({
					toolName: "Bash",
					toolCallId: `tc-${i}`,
					input: { command: "vitest run broken.spec.ts" },
					content: [{ type: "text", text: "FAIL broken.spec.ts\nError: something broke" }],
					isError: true,
				});
			}

			const state = harness.getConvergenceState("test:broken.spec.ts");
			expect(state).not.toBeNull();
			expect(state!.consecutiveFailures).toBeGreaterThanOrEqual(3);
		} finally {
			await harness.close();
			rmSync(testDir, { recursive: true });
		}
	});

	it("does not fire warning callback when failures are below threshold", async () => {
		const warnings: Array<{ state: ConvergenceState; result: EscalationResult }> = [];
		const testDir = makeTmpDir();

		const harness = makeHarness(testDir, {
			convergenceThresholds: { maxConsecutiveFailures: 5 },
			onConvergenceWarning: (state: ConvergenceState, result: EscalationResult) => {
				warnings.push({ state, result });
			},
		});

		const { mockAgentHarness, emit } = makeMockEmitter();
		harness.subscribeToEvents(mockAgentHarness);

		try {
			// Only 2 failures — below the threshold of 5
			for (let i = 1; i <= 2; i++) {
				emit({
					toolName: "Bash",
					toolCallId: `tc-${i}`,
					input: { command: "vitest run partial.spec.ts" },
					content: [{ type: "text", text: "FAIL partial.spec.ts\nError: minor issue" }],
					isError: true,
				});
			}

			// Callback should NOT have fired
			expect(warnings.length).toBe(0);
		} finally {
			await harness.close();
			rmSync(testDir, { recursive: true });
		}
	});
});
