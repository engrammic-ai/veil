/**
 * Attempt Records — Phase D.1 failure-memory foundation.
 *
 * AttemptStore: CRUD for tried-and-failed approaches.
 * normalizeError(): dedup-friendly error fingerprinting.
 * detectFailure(): classify tool results into outcome buckets.
 */

import type * as BetterSqlite3 from "better-sqlite3";
import { isTestRunner } from "./goal-inference.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AttemptOutcome = "fail" | "pass" | "partial" | "uncertain";

export interface AttemptRecord {
	id: string;
	sessionId: string;
	goalId: string;
	iteration: number;

	action: string;
	target?: string;
	rationale?: string;

	outcome: AttemptOutcome;
	evidence?: string;
	errorPattern?: string;

	createdAt: number;
	turn: number;
	goalOpen: boolean;
	pinned: boolean;
}

export interface AttemptDetection {
	outcome: AttemptOutcome;
	errorPattern?: string;
	evidence?: string;
}

// ─── AttemptStore ─────────────────────────────────────────────────────────────

/**
 * Thin CRUD wrapper around the `attempts` table.
 * Uses the same db connection as ContextCache — caller passes the db in.
 * Prepared statements are initialised once in the constructor.
 */
export class AttemptStore {
	private stmtPut: BetterSqlite3.Statement;
	private stmtGet: BetterSqlite3.Statement;
	private stmtGetByGoal: BetterSqlite3.Statement;
	private stmtGetBySession: BetterSqlite3.Statement;
	private stmtMarkResolved: BetterSqlite3.Statement;
	private stmtCountByGoal: BetterSqlite3.Statement;
	private stmtGetOpenByGoal: BetterSqlite3.Statement;
	private stmtDelete: BetterSqlite3.Statement;

	private db: BetterSqlite3.Database;

	constructor(db: BetterSqlite3.Database) {
		this.db = db;
		this.stmtPut = this.db.prepare(`
			INSERT OR REPLACE INTO attempts (
				id, session_id, goal_id, iteration,
				action, target, rationale,
				outcome, evidence, error_pattern,
				created_at, turn,
				goal_open, pinned
			) VALUES (
				?, ?, ?, ?,
				?, ?, ?,
				?, ?, ?,
				?, ?,
				?, ?
			)
		`);

		this.stmtGet = this.db.prepare("SELECT * FROM attempts WHERE id = ?");

		this.stmtGetByGoal = this.db.prepare(
			"SELECT * FROM attempts WHERE goal_id = ? ORDER BY turn ASC, created_at ASC",
		);

		this.stmtGetBySession = this.db.prepare(
			"SELECT * FROM attempts WHERE session_id = ? ORDER BY turn ASC, created_at ASC",
		);

		this.stmtMarkResolved = this.db.prepare("UPDATE attempts SET goal_open = 0 WHERE goal_id = ?");

		this.stmtCountByGoal = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE goal_id = ?");

		this.stmtGetOpenByGoal = this.db.prepare(
			"SELECT * FROM attempts WHERE goal_id = ? AND goal_open = 1 ORDER BY turn ASC, created_at ASC",
		);

		this.stmtDelete = this.db.prepare("DELETE FROM attempts WHERE id = ?");
	}

	put(record: AttemptRecord): void {
		this.stmtPut.run(
			record.id,
			record.sessionId,
			record.goalId,
			record.iteration,
			record.action,
			record.target ?? null,
			record.rationale ?? null,
			record.outcome,
			record.evidence ?? null,
			record.errorPattern ?? null,
			record.createdAt,
			record.turn,
			record.goalOpen ? 1 : 0,
			record.pinned ? 1 : 0,
		);
	}

	get(id: string): AttemptRecord | null {
		const row = this.stmtGet.get(id) as any;
		if (!row) return null;
		return this.rowToRecord(row);
	}

	getByGoal(goalId: string): AttemptRecord[] {
		const rows = this.stmtGetByGoal.all(goalId) as any[];
		return rows.map((r) => this.rowToRecord(r));
	}

	getOpenByGoal(goalId: string): AttemptRecord[] {
		const rows = this.stmtGetOpenByGoal.all(goalId) as any[];
		return rows.map((r) => this.rowToRecord(r));
	}

	getBySession(sessionId: string): AttemptRecord[] {
		const rows = this.stmtGetBySession.all(sessionId) as any[];
		return rows.map((r) => this.rowToRecord(r));
	}

	/** Mark all attempts for a goal as resolved (goal_open = 0). */
	markResolved(goalId: string): number {
		const result = this.stmtMarkResolved.run(goalId);
		return result.changes;
	}

	countByGoal(goalId: string): number {
		const row = this.stmtCountByGoal.get(goalId) as { count: number };
		return row?.count ?? 0;
	}

	delete(id: string): void {
		this.stmtDelete.run(id);
	}

	private rowToRecord(row: any): AttemptRecord {
		return {
			id: row.id,
			sessionId: row.session_id,
			goalId: row.goal_id,
			iteration: row.iteration,
			action: row.action,
			target: row.target ?? undefined,
			rationale: row.rationale ?? undefined,
			outcome: row.outcome as AttemptOutcome,
			evidence: row.evidence ?? undefined,
			errorPattern: row.error_pattern ?? undefined,
			createdAt: row.created_at,
			turn: row.turn,
			goalOpen: row.goal_open === 1,
			pinned: row.pinned === 1,
		};
	}
}

// ─── normalizeError (D.1.3) ───────────────────────────────────────────────────

/**
 * Normalize an error message for deduplication.
 *
 * Rules (applied in order):
 * 1. Strip line numbers: "error at line 45" -> "error at line N"
 *    and file:line:col notation: "foo.ts:45:3" -> "foo.ts:N:N"
 * 2. Anonymize absolute paths: "/home/user/project/src/foo.ts" -> "<path>/foo.ts"
 * 3. Extract error class pattern: "TypeError: Cannot read propert(y|ies) 'x'"
 *    -> "property-access-error"
 * 4. Normalize whitespace and lowercase
 * 5. Truncate to 200 chars
 */
export function normalizeError(content: Array<{ type: string; text?: string }>): string {
	const text = content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");

	return (
		text
			// Rule 1a: "at line N" patterns
			.replace(/at line \d+/gi, "at line N")
			// Rule 1b: file:line:col patterns (e.g. src/foo.ts:45:3)
			.replace(/:\d+:\d+/g, ":N:N")
			// Rule 2: absolute paths — keep only the final filename
			.replace(/\/[\w/\-. ]+\/([^/\s]+)/g, "<path>/$1")
			// Rule 3: TypeError/ReferenceError property access
			.replace(/Cannot read propert(?:y|ies) '[^']+'/g, "property-access-error")
			// Rule 4a: collapse whitespace
			.replace(/\s+/g, " ")
			// Rule 4b: lowercase
			.trim()
			.toLowerCase()
			// Rule 5: truncate
			.slice(0, 200)
	);
}

// ─── detectFailure (D.1.4) ────────────────────────────────────────────────────

/**
 * Classify a tool result event into an outcome bucket.
 *
 * Four detection paths (most-reliable first):
 * 1. isError flag  — definite fail
 * 2. Bash exit codes — definite fail on non-zero, uncertain on keyword match
 * 3. Test runner patterns (vitest/jest/pytest/go/cargo) — fail on N failed, pass on passed
 * 4. Common error patterns in any output — uncertain (prefer over false positive)
 *
 * Default: pass (no evidence of failure).
 */
export function detectFailure(event: {
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
}): AttemptDetection {
	const text = event.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");

	// Path 1: Explicit error flag — most reliable signal
	if (event.isError) {
		return {
			outcome: "fail",
			evidence: text.slice(0, 500),
			errorPattern: normalizeError(event.content),
		};
	}

	const toolNameLower = event.toolName.toLowerCase();

	// Path 2: Bash exit codes (skip if this is a test runner — Path 3 handles those)
	if (toolNameLower === "bash" && !isTestRunner(event.toolName, event.input)) {
		// Some Pi/Veil bash tool formats: "exit code: N" or "exited with code N"
		const exitMatch = text.match(/exit(?:ed with)? code[:\s]+(\d+)/i);
		if (exitMatch && exitMatch[1] !== "0") {
			return {
				outcome: "fail",
				evidence: `Exit code ${exitMatch[1]}`,
				errorPattern: normalizeError(event.content),
			};
		}
		// Keyword match in bash output — uncertain, not definite
		if (/\b(?:error|failed|fatal|panic|exception)\b/i.test(text)) {
			return {
				outcome: "uncertain",
				evidence: text.slice(0, 500),
				errorPattern: normalizeError(event.content),
			};
		}
	}

	// Path 3: Test runner patterns
	if (isTestRunner(event.toolName, event.input)) {
		const failMatch = text.match(/(\d+)\s+(?:failed|failing)/i);
		if (failMatch && parseInt(failMatch[1], 10) > 0) {
			return {
				outcome: "fail",
				evidence: `${failMatch[1]} test(s) failed`,
				errorPattern: extractFailedTestNames(text) || normalizeError(event.content),
			};
		}
		const passMatch = text.match(/(\d+)\s+(?:passed|passing)/i);
		if (passMatch) {
			return { outcome: "pass" };
		}
	}

	// Path 4: Common error patterns in any tool output — prefer uncertain over false positive
	const ERROR_PATTERNS: RegExp[] = [
		/\bError:\s*(.{1,100})/i,
		/\bTypeError:\s*(.{1,100})/i,
		/\bSyntaxError:\s*(.{1,100})/i,
		/\bReferenceError:\s*(.{1,100})/i,
		/\bFAILED\b/i,
		/\bfatal:/i,
		/\bpanic:/i,
	];

	for (const pattern of ERROR_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			return {
				outcome: "uncertain",
				evidence: match[0].slice(0, 200),
				errorPattern: normalizeError(event.content),
			};
		}
	}

	// Default: no evidence of failure
	return { outcome: "pass" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract test names from common failure formats (Jest/Vitest/pytest/Go). */
export function extractFailedTestNames(text: string): string {
	const names: string[] = [];
	const patterns: RegExp[] = [
		/FAIL\s+([^\n]+)/g, // Jest/Vitest
		/FAILED\s+([^\n]+)/g, // pytest
		/--- FAIL:\s*([^\n]+)/g, // Go
	];
	for (const pattern of patterns) {
		let match = pattern.exec(text);
		while (match !== null) {
			names.push(match[1].trim().slice(0, 50));
			match = pattern.exec(text);
		}
	}
	return names.slice(0, 5).join(";");
}
