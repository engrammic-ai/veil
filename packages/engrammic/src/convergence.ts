/**
 * Convergence Monitor — Phase D.3 escalation system.
 *
 * Detects when the agent is stuck in a failure loop and escalates:
 * - Soft: Warning injected into failure section
 * - Medium: onConvergenceWarning callback fired
 * - Hard: onConvergenceHalt callback or terminate signal
 */

import type { AttemptRecord } from "./attempts.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConvergenceState {
	goalId: string;
	totalAttempts: number;
	consecutiveFailures: number;
	uniqueApproaches: number;
	lastProgressTurn: number;
	turnsWithoutProgress: number;
	lastAttempt: AttemptRecord | null;
}

export interface ConvergenceThresholds {
	maxConsecutiveFailures: number;
	maxTurnsWithoutProgress: number;
	maxTotalAttempts: number;
	escalateOnRepeat: number;
}

export const DEFAULT_THRESHOLDS: ConvergenceThresholds = {
	maxConsecutiveFailures: 5,
	maxTurnsWithoutProgress: 10,
	maxTotalAttempts: 15,
	escalateOnRepeat: 3,
};

export type EscalationLevel = 0 | 1 | 2 | 3;

export interface EscalationResult {
	level: EscalationLevel;
	reason?: string;
}

// ─── Progress Detection (D.3.2) ───────────────────────────────────────────────

/**
 * Determines if the current attempt represents progress from the previous.
 *
 * Progress is defined as:
 * - First attempt (no previous)
 * - Outcome improved to pass or partial
 * - Error pattern changed (trying something different)
 * - Different target file touched
 */
export function isProgress(prev: AttemptRecord | null, curr: AttemptRecord): boolean {
	if (!prev) return true;
	if (curr.outcome === "pass" || curr.outcome === "partial") return true;
	if (curr.errorPattern !== prev.errorPattern) return true;
	if (curr.target !== prev.target) return true;
	return false;
}

// ─── ConvergenceMonitor (D.3.1) ───────────────────────────────────────────────

/**
 * Tracks convergence state per goal and determines escalation levels.
 */
export class ConvergenceMonitor {
	private states: Map<string, ConvergenceState> = new Map();
	private thresholds: ConvergenceThresholds;

	constructor(thresholds: Partial<ConvergenceThresholds> = {}) {
		this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
	}

	/**
	 * Update convergence state with a new attempt.
	 * Returns the escalation result after processing.
	 */
	update(attempt: AttemptRecord, currentTurn: number): EscalationResult {
		const goalId = attempt.goalId;
		let state = this.states.get(goalId);

		if (!state) {
			state = {
				goalId,
				totalAttempts: 0,
				consecutiveFailures: 0,
				uniqueApproaches: 0,
				lastProgressTurn: currentTurn,
				turnsWithoutProgress: 0,
				lastAttempt: null,
			};
			this.states.set(goalId, state);
		}

		const prev = state.lastAttempt;

		state.totalAttempts++;

		if (attempt.outcome === "fail" || attempt.outcome === "uncertain") {
			state.consecutiveFailures++;
		} else {
			state.consecutiveFailures = 0;
		}

		if (isProgress(prev, attempt)) {
			state.lastProgressTurn = currentTurn;
			state.turnsWithoutProgress = 0;
			if (attempt.errorPattern && !this.hasSeenPattern(state, attempt.errorPattern)) {
				state.uniqueApproaches++;
			}
		} else {
			state.turnsWithoutProgress = currentTurn - state.lastProgressTurn;
		}

		if (attempt.errorPattern) {
			this.recordPattern(goalId, attempt.errorPattern);
		}

		state.lastAttempt = attempt;

		return this.checkConvergence(state, attempt);
	}

	/**
	 * Check convergence thresholds and return escalation level.
	 *
	 * Level 0: No escalation
	 * Level 1: Soft warning (inject into context)
	 * Level 2: Medium warning (fire callback)
	 * Level 3: Hard halt (terminate or fire halt callback)
	 */
	checkConvergence(state: ConvergenceState, latestAttempt?: AttemptRecord): EscalationResult {
		const { thresholds } = this;

		// Hard escalation: total attempts exceeded
		if (state.totalAttempts >= thresholds.maxTotalAttempts) {
			return {
				level: 3,
				reason: `Exceeded ${thresholds.maxTotalAttempts} total attempts on this goal`,
			};
		}

		// Hard escalation: turns without progress exceeded
		if (state.turnsWithoutProgress >= thresholds.maxTurnsWithoutProgress) {
			return {
				level: 3,
				reason: `No progress for ${state.turnsWithoutProgress} turns`,
			};
		}

		// Medium escalation: consecutive failures at threshold
		if (state.consecutiveFailures >= thresholds.maxConsecutiveFailures) {
			return {
				level: 2,
				reason: `${state.consecutiveFailures} consecutive failures`,
			};
		}

		// Soft escalation: same error pattern repeating
		if (latestAttempt?.errorPattern) {
			const repeatCount = this.countPatternOccurrences(state, latestAttempt.errorPattern);
			if (repeatCount >= thresholds.escalateOnRepeat) {
				return {
					level: 1,
					reason: `Same error pattern "${latestAttempt.errorPattern.slice(0, 40)}" repeated ${repeatCount} times`,
				};
			}
		}

		return { level: 0 };
	}

	/**
	 * Get the current convergence state for a goal.
	 */
	getState(goalId: string): ConvergenceState | null {
		return this.states.get(goalId) ?? null;
	}

	/**
	 * Reset state for a goal (e.g., when goal is resolved).
	 */
	resetGoal(goalId: string): void {
		this.states.delete(goalId);
	}

	/**
	 * Get all active convergence states.
	 */
	getAllStates(): ConvergenceState[] {
		return Array.from(this.states.values());
	}

	/**
	 * Update thresholds at runtime.
	 */
	setThresholds(thresholds: Partial<ConvergenceThresholds>): void {
		this.thresholds = { ...this.thresholds, ...thresholds };
	}

	getThresholds(): ConvergenceThresholds {
		return { ...this.thresholds };
	}

	// ─── Private Helpers ──────────────────────────────────────────────────────

	private patternHistory: Map<string, string[]> = new Map();

	private hasSeenPattern(state: ConvergenceState, pattern: string): boolean {
		const history = this.patternHistory.get(state.goalId) ?? [];
		return history.includes(pattern);
	}

	private countPatternOccurrences(state: ConvergenceState, pattern: string): number {
		const history = this.patternHistory.get(state.goalId) ?? [];
		return history.filter((p) => p === pattern).length;
	}

	/**
	 * Record a pattern occurrence for tracking repeats.
	 */
	recordPattern(goalId: string, pattern: string): void {
		const history = this.patternHistory.get(goalId) ?? [];
		history.push(pattern);
		this.patternHistory.set(goalId, history);
	}
}

// ─── Warning Message Builder (D.3.5) ──────────────────────────────────────────

/**
 * Build a warning message for soft escalation.
 */
export function buildConvergenceWarning(state: ConvergenceState, result: EscalationResult): string {
	if (result.level === 0) return "";

	const lines: string[] = [];

	if (result.level >= 1) {
		lines.push(`[CONVERGENCE WARNING] ${result.reason}`);
	}

	if (result.level >= 2) {
		lines.push(`Consider: stepping back, trying a different approach, or asking for help.`);
	}

	if (result.level >= 3) {
		lines.push(`[HALT RECOMMENDED] This goal appears stuck. Manual intervention may be needed.`);
	}

	lines.push(
		`Stats: ${state.totalAttempts} attempts, ${state.consecutiveFailures} consecutive failures, ${state.uniqueApproaches} unique approaches tried.`,
	);

	return lines.join("\n");
}
