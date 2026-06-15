/**
 * Unit tests for goal-inference.ts (Phase D.4)
 */

import { describe, expect, test } from "vitest";
import type { AttemptRecord } from "./attempts.ts";
import {
	advanceGoalState,
	createGoalInferenceState,
	DEFAULT_LLM_CONFIG,
	detectRetryMarker,
	extractRationale,
	extractTarget,
	extractTestSuite,
	inferGoalId,
	inferGoalWithLLM,
	isTestRunner,
	normalizeCommand,
	normalizeFilePath,
	shouldCloseGoal,
	shouldMergeGoals,
} from "./goal-inference.ts";
import type { ToolResultEvent } from "./harness.ts";

function makeEvent(
	toolName: string,
	input: Record<string, unknown>,
	opts: { isError?: boolean } = {},
): ToolResultEvent {
	return {
		toolName,
		input,
		content: [],
		isError: opts.isError ?? false,
	};
}

// ---------------------------------------------------------------------------
// extractTarget — D.4.1
// ---------------------------------------------------------------------------

describe("extractTarget", () => {
	test("Read tool with file_path", () => {
		const event = makeEvent("Read", { file_path: "/src/foo.ts" });
		expect(extractTarget(event)).toBe("/src/foo.ts");
	});

	test("Edit tool with file_path", () => {
		const event = makeEvent("Edit", { file_path: "/src/bar.ts", old_string: "a", new_string: "b" });
		expect(extractTarget(event)).toBe("/src/bar.ts");
	});

	test("tool with path field", () => {
		const event = makeEvent("SomeTool", { path: "/tmp/work/file.json" });
		expect(extractTarget(event)).toBe("/tmp/work/file.json");
	});

	test("Bash with a .ts file in command", () => {
		const event = makeEvent("Bash", { command: "npx tsc --noEmit src/auth.ts" });
		expect(extractTarget(event)).toBe("src/auth.ts");
	});

	test("Bash with a .py file in command", () => {
		const event = makeEvent("Bash", { command: "python scripts/migrate.py --dry-run" });
		expect(extractTarget(event)).toBe("scripts/migrate.py");
	});

	test("Bash without any file ref returns null", () => {
		const event = makeEvent("Bash", { command: "git status" });
		expect(extractTarget(event)).toBeNull();
	});

	test("unknown tool without file fields returns null", () => {
		const event = makeEvent("WebSearch", { query: "vitest docs" });
		expect(extractTarget(event)).toBeNull();
	});

	test("file_path takes precedence over bash parsing when both present", () => {
		// This scenario doesn't normally arise (Read never has a bash command),
		// but the priority contract should hold if fields coexist.
		const event = makeEvent("Read", { file_path: "/src/explicit.ts", command: "cat implicit.ts" });
		expect(extractTarget(event)).toBe("/src/explicit.ts");
	});
});

// ---------------------------------------------------------------------------
// isTestRunner
// ---------------------------------------------------------------------------

describe("isTestRunner", () => {
	test('"vitest run" → true', () => {
		expect(isTestRunner("Bash", { command: "vitest run" })).toBe(true);
	});

	test('"jest --watch" → true', () => {
		expect(isTestRunner("Bash", { command: "jest --watch" })).toBe(true);
	});

	test('"pytest tests/" → true', () => {
		expect(isTestRunner("Bash", { command: "pytest tests/" })).toBe(true);
	});

	test('"npm test" → true', () => {
		expect(isTestRunner("Bash", { command: "npm test" })).toBe(true);
	});

	test('"pnpm test" → true', () => {
		expect(isTestRunner("Bash", { command: "pnpm test" })).toBe(true);
	});

	test('"go test ./..." → true', () => {
		expect(isTestRunner("Bash", { command: "go test ./..." })).toBe(true);
	});

	test('"cargo test" → true', () => {
		expect(isTestRunner("Bash", { command: "cargo test" })).toBe(true);
	});

	test('"npm install" → false', () => {
		expect(isTestRunner("Bash", { command: "npm install" })).toBe(false);
	});

	test("non-bash tool → false", () => {
		expect(isTestRunner("Read", { command: "vitest run" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// extractTestSuite
// ---------------------------------------------------------------------------

describe("extractTestSuite", () => {
	test('"vitest run src/foo.test.ts" → "src/foo.test.ts"', () => {
		expect(extractTestSuite({ command: "vitest run src/foo.test.ts" })).toBe("src/foo.test.ts");
	});

	test('"vitest run" with no suite → null', () => {
		expect(extractTestSuite({ command: "vitest run" })).toBeNull();
	});

	test('"jest foo.spec.ts" → "foo.spec.ts"', () => {
		expect(extractTestSuite({ command: "jest foo.spec.ts" })).toBe("foo.spec.ts");
	});

	test('"pytest tests/foo.py" → "tests/foo.py"', () => {
		expect(extractTestSuite({ command: "pytest tests/foo.py" })).toBe("tests/foo.py");
	});

	test('"npm test -- foo.spec.ts" → "foo.spec.ts"', () => {
		expect(extractTestSuite({ command: "npm test -- foo.spec.ts" })).toBe("foo.spec.ts");
	});

	test('"go test ./pkg/auth" → "./pkg/auth"', () => {
		expect(extractTestSuite({ command: "go test ./pkg/auth" })).toBe("./pkg/auth");
	});

	test('"cargo test auth_module" → "auth_module"', () => {
		expect(extractTestSuite({ command: "cargo test auth_module" })).toBe("auth_module");
	});
});

// ---------------------------------------------------------------------------
// normalizeFilePath
// ---------------------------------------------------------------------------

describe("normalizeFilePath", () => {
	test("collapses double slashes", () => {
		expect(normalizeFilePath("/src//foo.ts")).toBe("/src/foo.ts");
	});

	test("strips trailing slash", () => {
		expect(normalizeFilePath("/src/foo/")).toBe("/src/foo");
	});

	test("leaves clean path unchanged", () => {
		expect(normalizeFilePath("/src/foo.ts")).toBe("/src/foo.ts");
	});

	test("collapses multiple consecutive slashes", () => {
		expect(normalizeFilePath("/src///deep//path.ts")).toBe("/src/deep/path.ts");
	});
});

// ---------------------------------------------------------------------------
// normalizeCommand
// ---------------------------------------------------------------------------

describe("normalizeCommand", () => {
	test("strips flags and lowercases", () => {
		const result = normalizeCommand("npm install --save-dev vitest");
		expect(result).not.toContain("--save-dev");
		expect(result).toBe(result.toLowerCase());
		expect(result).toContain("npm install");
		expect(result).toContain("vitest");
	});

	test("long command truncated to 80 chars", () => {
		const long = `echo ${"a".repeat(100)}`;
		expect(normalizeCommand(long).length).toBeLessThanOrEqual(80);
	});

	test("multiple spaces collapsed", () => {
		const result = normalizeCommand("git   commit   -m   msg");
		// After flag stripping "-m" is gone; remaining spaces should collapse
		expect(result).not.toMatch(/\s{2,}/);
	});

	test("result is lowercase", () => {
		const result = normalizeCommand("NPM INSTALL FOO");
		expect(result).toBe(result.toLowerCase());
	});
});

// ---------------------------------------------------------------------------
// shouldMergeGoals — D.4.3
// ---------------------------------------------------------------------------

describe("shouldMergeGoals", () => {
	test("same directory → true", () => {
		const state = createGoalInferenceState();
		const s = advanceGoalState(state, "file:/src/auth/bar.ts", "/src/auth/bar.ts", 1);
		expect(shouldMergeGoals("/src/auth/foo.ts", s)).toBe(true);
	});

	test("same base name (foo.ts and foo.test.ts) → true", () => {
		const state = createGoalInferenceState();
		const s = advanceGoalState(state, "file:/src/auth.test.ts", "/src/auth.test.ts", 1);
		expect(shouldMergeGoals("/src/auth.ts", s)).toBe(true);
	});

	test("different dir and different base → false", () => {
		const state = createGoalInferenceState();
		const s = advanceGoalState(state, "file:/src/billing/invoice.ts", "/src/billing/invoice.ts", 1);
		expect(shouldMergeGoals("/src/auth/login.ts", s)).toBe(false);
	});

	test("empty recentTargets → false", () => {
		const state = createGoalInferenceState();
		expect(shouldMergeGoals("/src/foo.ts", state)).toBe(false);
	});

	test("root-level files with same base name → true", () => {
		// No slashes: dir is ""; base name matching should still work.
		const state = createGoalInferenceState();
		const s = advanceGoalState(state, "file:auth.test.ts", "auth.test.ts", 1);
		expect(shouldMergeGoals("auth.ts", s)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// inferGoalId — D.4.2
// ---------------------------------------------------------------------------

describe("inferGoalId", () => {
	test("Read tool with absolute file_path → file: prefix", () => {
		const event = makeEvent("Read", { file_path: "/src/foo.ts" });
		const state = createGoalInferenceState();
		expect(inferGoalId(event, state)).toBe("file:/src/foo.ts");
	});

	test("Bash with vitest and suite → test: prefix", () => {
		const event = makeEvent("Bash", { command: "vitest run foo.spec.ts" });
		const state = createGoalInferenceState();
		expect(inferGoalId(event, state)).toBe("test:foo.spec.ts");
	});

	test("Bash with no file and no test runner → cmd: prefix", () => {
		const event = makeEvent("Bash", { command: "git status" });
		const state = createGoalInferenceState();
		const id = inferGoalId(event, state);
		expect(id.startsWith("cmd:")).toBe(true);
		expect(id).toContain("git");
	});

	test("no target + has currentGoalId → returns currentGoalId", () => {
		const event = makeEvent("WebSearch", { query: "foo" });
		const state: ReturnType<typeof createGoalInferenceState> = {
			currentGoalId: "file:/src/foo.ts",
			turn: 3,
			recentTargets: [],
		};
		expect(inferGoalId(event, state)).toBe("file:/src/foo.ts");
	});

	test("no target + no currentGoalId → turn: fallback", () => {
		const event = makeEvent("WebSearch", { query: "foo" });
		const state = createGoalInferenceState(5);
		expect(inferGoalId(event, state)).toBe("turn:5");
	});

	test("second file in same dir → returns existing currentGoalId (merge)", () => {
		const state: ReturnType<typeof createGoalInferenceState> = {
			currentGoalId: "file:/src/auth/login.ts",
			turn: 2,
			recentTargets: ["/src/auth/login.ts"],
		};
		const event = makeEvent("Edit", { file_path: "/src/auth/logout.ts" });
		expect(inferGoalId(event, state)).toBe("file:/src/auth/login.ts");
	});
});

// ---------------------------------------------------------------------------
// createGoalInferenceState
// ---------------------------------------------------------------------------

describe("createGoalInferenceState", () => {
	test("default turn=0", () => {
		const s = createGoalInferenceState();
		expect(s.turn).toBe(0);
	});

	test("custom turn", () => {
		const s = createGoalInferenceState(7);
		expect(s.turn).toBe(7);
	});

	test("null currentGoalId and empty recentTargets", () => {
		const s = createGoalInferenceState();
		expect(s.currentGoalId).toBeNull();
		expect(s.recentTargets).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// advanceGoalState
// ---------------------------------------------------------------------------

describe("advanceGoalState", () => {
	test("adds target to recentTargets", () => {
		const s = createGoalInferenceState(0);
		const next = advanceGoalState(s, "file:/src/foo.ts", "/src/foo.ts", 1);
		expect(next.recentTargets).toContain("/src/foo.ts");
	});

	test("caps recentTargets at 5", () => {
		let s = createGoalInferenceState(0);
		for (let i = 0; i < 6; i++) {
			s = advanceGoalState(s, `file:/src/file${i}.ts`, `/src/file${i}.ts`, i + 1);
		}
		expect(s.recentTargets.length).toBe(5);
		// Most recent entry should be the last one added
		expect(s.recentTargets[4]).toBe("/src/file5.ts");
	});

	test("updates currentGoalId and turn", () => {
		const s = createGoalInferenceState(0);
		const next = advanceGoalState(s, "file:/src/foo.ts", "/src/foo.ts", 3);
		expect(next.currentGoalId).toBe("file:/src/foo.ts");
		expect(next.turn).toBe(3);
	});

	test("null target does not add to recentTargets", () => {
		const s = createGoalInferenceState(0);
		const next = advanceGoalState(s, "cmd:git status", null, 1);
		expect(next.recentTargets).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// D.4.5 — detectRetryMarker
// ---------------------------------------------------------------------------

describe("detectRetryMarker", () => {
	test("detects 'that didn't work'", () => {
		expect(detectRetryMarker("that didn't work, let me try something else")).toBeTruthy();
	});

	test("detects 'let me try'", () => {
		expect(detectRetryMarker("let me try a different approach")).toBeTruthy();
	});

	test("detects 'still failing'", () => {
		expect(detectRetryMarker("The test is still failing")).toBeTruthy();
	});

	test("detects 'same error'", () => {
		expect(detectRetryMarker("Getting the same error as before")).toBeTruthy();
	});

	test("returns null for normal text", () => {
		expect(detectRetryMarker("I'll update the authentication module")).toBeNull();
	});

	test("returns matched marker text", () => {
		const result = detectRetryMarker("that didn't work, so I'll fix it");
		expect(result).toBe("that didn't work");
	});
});

// ---------------------------------------------------------------------------
// D.4.6 — extractRationale
// ---------------------------------------------------------------------------

describe("extractRationale", () => {
	test("extracts 'let me' pattern", () => {
		const result = extractRationale("let me fix the null check in the auth module");
		expect(result).toBe("fix the null check in the auth module");
	});

	test("extracts 'I'll' pattern", () => {
		const result = extractRationale("I'll update the config to use the new format");
		expect(result).toBe("update the config to use the new format");
	});

	test("extracts 'because' pattern", () => {
		const result = extractRationale("because the variable is undefined at this point");
		expect(result).toBe("the variable is undefined at this point");
	});

	test("extracts 'the issue is' pattern", () => {
		const result = extractRationale("the issue is that we're not handling null values");
		expect(result).toBe("that we're not handling null values");
	});

	test("returns null for short matches", () => {
		expect(extractRationale("let me try")).toBeNull();
	});

	test("returns null for non-matching text", () => {
		expect(extractRationale("Running the test suite now")).toBeNull();
	});

	test("truncates to 100 chars", () => {
		const long = `let me ${"a".repeat(150)}`;
		const result = extractRationale(long);
		expect(result?.length).toBeLessThanOrEqual(100);
	});
});

// ---------------------------------------------------------------------------
// D.4.7 — shouldCloseGoal
// ---------------------------------------------------------------------------

function makeAttemptRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
	return {
		id: "attempt-1",
		sessionId: "session-1",
		goalId: "file:auth.ts",
		iteration: 1,
		action: "bash",
		target: "auth.ts",
		outcome: "fail",
		evidence: "Test failed",
		errorPattern: "test-failure",
		createdAt: Date.now(),
		turn: 1,
		goalOpen: true,
		pinned: false,
		...overrides,
	};
}

describe("shouldCloseGoal", () => {
	test("returns false for empty attempts", () => {
		expect(shouldCloseGoal([], 5)).toBe(false);
	});

	test("returns false when last attempt is fail", () => {
		const attempts = [makeAttemptRecord({ outcome: "fail", turn: 4 })];
		expect(shouldCloseGoal(attempts, 5)).toBe(false);
	});

	test("returns true when last is pass and no recent failures", () => {
		const attempts = [
			makeAttemptRecord({ id: "a1", outcome: "fail", turn: 1 }),
			makeAttemptRecord({ id: "a2", outcome: "pass", turn: 5 }),
		];
		expect(shouldCloseGoal(attempts, 5)).toBe(true);
	});

	test("returns false when pass but failure in last 3 turns", () => {
		const attempts = [
			makeAttemptRecord({ id: "a1", outcome: "fail", turn: 3 }),
			makeAttemptRecord({ id: "a2", outcome: "pass", turn: 5 }),
		];
		expect(shouldCloseGoal(attempts, 5)).toBe(false);
	});

	test("returns true when failure is more than 3 turns ago", () => {
		const attempts = [
			makeAttemptRecord({ id: "a1", outcome: "fail", turn: 1 }),
			makeAttemptRecord({ id: "a2", outcome: "pass", turn: 5 }),
		];
		expect(shouldCloseGoal(attempts, 5)).toBe(true);
	});

	test("handles uncertain as failure", () => {
		const attempts = [
			makeAttemptRecord({ id: "a1", outcome: "uncertain", turn: 4 }),
			makeAttemptRecord({ id: "a2", outcome: "pass", turn: 5 }),
		];
		expect(shouldCloseGoal(attempts, 5)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// D.4.8 — inferGoalWithLLM (stub)
// ---------------------------------------------------------------------------

describe("inferGoalWithLLM", () => {
	test("returns null (stub implementation)", () => {
		const result = inferGoalWithLLM("some agent text", {
			recentTargets: [],
			currentGoalId: null,
		});
		expect(result).toBeNull();
	});

	test("default config has enabled=false", () => {
		expect(DEFAULT_LLM_CONFIG.enabled).toBe(false);
	});
});
