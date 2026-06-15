/**
 * Goal-inference for Veil failure-memory (Phase D.4.1-D.4.3).
 *
 * Infers goal boundaries from tool events without LLM calls.
 * Uses a three-level cascade:
 *   Level 1: file/bash target extraction (deterministic)
 *   Level 2: test-suite extraction
 *   Level 3: command normalization fallback
 *
 * D.4.1 — extractTarget()
 * D.4.2 — inferGoalId()
 * D.4.3 — shouldMergeGoals()
 */

import type { ToolResultEvent } from "./harness.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sliding window of recently-seen targets, used for goal merging.
 * Tracks the current goal so inferGoalId() can decide to continue it.
 */
export interface GoalInferenceState {
	/** Currently active goal ID, or null at session start. */
	currentGoalId: string | null;
	/** Current turn number from the harness. */
	turn: number;
	/** Targets seen in the last 5 events, newest last. */
	recentTargets: string[];
}

// ---------------------------------------------------------------------------
// D.4.1 — extractTarget
// ---------------------------------------------------------------------------

/**
 * Extract the primary file/command target from a tool event.
 *
 * Priority:
 * 1. `file_path` field (Read/Write/Edit tools)
 * 2. `path` field (generic path tools)
 * 3. First source-code file path found in a bash command
 *
 * Returns null when no target can be determined.
 */
export function extractTarget(event: ToolResultEvent): string | null {
	const input = event.input;

	// 1. Named file fields used by file-manipulation tools
	if (typeof input.file_path === "string" && input.file_path) {
		return input.file_path;
	}
	if (typeof input.path === "string" && input.path) {
		return input.path;
	}

	// 2. Parse the command string for a source-code file reference
	if (event.toolName === "bash" || event.toolName === "Bash") {
		const cmd = String(input.command ?? "");
		// Match a path component that ends in a known source extension.
		// The pattern requires at least one path character before the extension
		// so bare extension names like ".ts" are not matched.
		const fileMatch = cmd.match(
			/(?:^|\s)([\w.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|c|cpp|h|sh|json|yaml|yml|toml|md))\b/,
		);
		if (fileMatch) return fileMatch[1];
	}

	return null;
}

// ---------------------------------------------------------------------------
// Helpers referenced by inferGoalId
// ---------------------------------------------------------------------------

/**
 * Returns true when the bash command looks like a test-runner invocation.
 */
export function isTestRunner(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "bash" && toolName !== "Bash") return false;
	const cmd = String(input.command ?? "");
	return /\b(vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|go\s+test|cargo\s+test|bun\s+test)\b/i.test(cmd);
}

/**
 * Extract the test suite/file name from a test-runner command.
 *
 * Handles patterns like:
 *   vitest run foo.spec.ts
 *   jest --testPathPattern=foo
 *   npm test -- foo
 *   pytest tests/foo.py
 */
export function extractTestSuite(input: Record<string, unknown>): string | null {
	const cmd = String(input.command ?? "");

	// "vitest run <file>" — explicit "run" subcommand followed by a suite argument
	const vitestRunMatch = cmd.match(/\bvitest\s+run\s+(\S+)/i);
	if (vitestRunMatch) return vitestRunMatch[1];

	// "vitest <file>" (no "run" keyword), "jest <file>", "pytest <file>"
	// Exclude bare subcommand words so "vitest run" (no suite) returns null.
	const runMatch = cmd.match(/\b(?:vitest|jest|pytest)\s+((?!run\b)\S+)/i);
	if (runMatch) return runMatch[1];

	// "npm test -- <file>" or "pnpm test <file>"
	const npmMatch = cmd.match(/\b(?:npm|pnpm|yarn|bun)\s+test\s+(?:--\s+)?(\S+)/i);
	if (npmMatch) return npmMatch[1];

	// "go test ./pkg/..." or "cargo test module"
	const goCargoMatch = cmd.match(/\b(?:go|cargo)\s+test\s+(\S+)/i);
	if (goCargoMatch) return goCargoMatch[1];

	return null;
}

/**
 * Extract the raw command string from a bash tool input.
 */
function extractCommand(input: Record<string, unknown>): string {
	return String(input.command ?? "").trim();
}

/**
 * Normalize a file path for use as a goal ID key.
 *
 * - Collapses repeated slashes
 * - Removes trailing slashes
 * - Keeps the path as-is otherwise (no lowercasing, preserves case-sensitive FSes)
 */
export function normalizeFilePath(filePath: string): string {
	return filePath.replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Normalize a bash command for use as a goal ID key.
 *
 * Rules:
 * - Strip flags/options (leading dashes) to focus on the verb + noun
 * - Collapse whitespace
 * - Lowercase
 * - Truncate to 80 chars to keep IDs legible
 */
export function normalizeCommand(cmd: string): string {
	return cmd
		.replace(/\s+--?\w[\w-]*(=\S+)?/g, " ") // strip flags
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.slice(0, 80);
}

// ---------------------------------------------------------------------------
// D.4.3 — shouldMergeGoals
// ---------------------------------------------------------------------------

/**
 * Returns true when `target` is related enough to recent targets that we
 * should continue the current goal rather than starting a new one.
 *
 * Merge rules (both conservative to avoid false grouping):
 *   1. Same directory — e.g. editing two files in `src/auth/`
 *   2. Same base name — e.g. `auth.ts` and `auth.test.ts`
 */
export function shouldMergeGoals(target: string, state: GoalInferenceState): boolean {
	if (state.recentTargets.length === 0) return false;

	// Derive directory: everything before the last "/" segment.
	// For paths without "/", dir is "" (treated as root-level).
	const targetDir = target.includes("/") ? target.replace(/\/[^/]+$/, "") : "";

	// Strip test/spec suffix and extension to get base name.
	const targetBase = stripTestAndExt(target);

	for (const recent of state.recentTargets) {
		// Rule 1: same directory
		const recentDir = recent.includes("/") ? recent.replace(/\/[^/]+$/, "") : "";
		if (targetDir !== "" && targetDir === recentDir) return true;

		// Rule 2: same base name (handles foo.ts <-> foo.test.ts)
		const recentBase = stripTestAndExt(recent);
		if (targetBase !== "" && targetBase === recentBase) return true;
	}

	return false;
}

/**
 * Strip test/spec qualifier and file extension from a path/filename.
 *
 * Examples:
 *   /src/auth/auth.test.ts  ->  /src/auth/auth
 *   /src/auth/auth.spec.js  ->  /src/auth/auth
 *   /src/auth/auth.ts       ->  /src/auth/auth
 *   auth.test.ts            ->  auth
 */
function stripTestAndExt(filePath: string): string {
	return filePath
		.replace(/\.(test|spec)\.[^.]+$/, "") // remove .test.ext or .spec.ext
		.replace(/\.[^./]+$/, ""); // remove remaining extension
}

// ---------------------------------------------------------------------------
// D.4.2 — inferGoalId
// ---------------------------------------------------------------------------

/**
 * Infer a goal ID from a tool event, using the current inference state for
 * merging and fallback decisions.
 *
 * Goal ID format:
 *   file:<normalized-path>   — file-manipulation tool or bash referencing a file
 *   test:<suite>             — test-runner invocation with identifiable suite
 *   cmd:<normalized-command> — generic bash command
 *   turn:<N>                 — last resort when no target can be extracted
 *
 * When `shouldMergeGoals` returns true, the current goal ID is preserved so
 * related multi-file edits are grouped together.
 */
export function inferGoalId(event: ToolResultEvent, state: GoalInferenceState): string {
	const target = extractTarget(event);

	// Check for goal merging before assigning a new ID.
	if (target && state.currentGoalId && shouldMergeGoals(target, state)) {
		return state.currentGoalId;
	}

	// Test-runner check takes priority over bash-parsed file targets.
	// (A test command like "vitest run foo.spec.ts" should produce test:foo.spec.ts,
	// not file:foo.spec.ts, even though extractTarget would find foo.spec.ts.)
	if (isTestRunner(event.toolName, event.input)) {
		const suite = extractTestSuite(event.input);
		if (suite) return `test:${suite}`;
	}

	// Primary: file path from an explicit field (file_path / path) or bash reference
	if (target && (target.startsWith("/") || target.includes("."))) {
		return `file:${normalizeFilePath(target)}`;
	}

	// Tertiary: normalized bash command
	if (event.toolName === "bash" || event.toolName === "Bash") {
		const cmd = extractCommand(event.input);
		if (cmd) return `cmd:${normalizeCommand(cmd)}`;
	}

	// Fallback: continue current goal or start a turn-scoped one
	return state.currentGoalId ?? `turn:${state.turn}`;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh GoalInferenceState for a new session.
 */
export function createGoalInferenceState(turn = 0): GoalInferenceState {
	return {
		currentGoalId: null,
		turn,
		recentTargets: [],
	};
}

/**
 * Advance the state after processing an event.
 *
 * - Updates `currentGoalId` to the newly inferred ID.
 * - Appends `target` to `recentTargets`, keeping the window at <=5 entries.
 * - Updates `turn`.
 */
export function advanceGoalState(
	state: GoalInferenceState,
	newGoalId: string,
	target: string | null,
	turn: number,
): GoalInferenceState {
	const recentTargets = target ? [...state.recentTargets, target].slice(-5) : state.recentTargets;

	return {
		currentGoalId: newGoalId,
		turn,
		recentTargets,
	};
}
