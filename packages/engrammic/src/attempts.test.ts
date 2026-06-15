import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type AttemptRecord, AttemptStore, detectFailure, extractFailedTestNames, normalizeError } from "./attempts.ts";
import { ContextCache } from "./cache.ts";
import { isTestRunner } from "./goal-inference.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeText(text: string) {
	return [{ type: "text", text }];
}

function makeRecord(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
	return {
		id: `attempt_${Date.now()}_${Math.random()}`,
		sessionId: "session-1",
		goalId: "goal-1",
		iteration: 1,
		action: "bash",
		outcome: "fail",
		createdAt: Date.now(),
		turn: 1,
		goalOpen: true,
		pinned: false,
		...overrides,
	};
}

// ─── D.1.1 — Schema (via ContextCache) ───────────────────────────────────────

describe("D.1.1 attempts table schema", () => {
	let testDir: string;
	let cache: ContextCache;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-attempts-schema-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("attempts table exists after init", () => {
		const db = cache.getDb();
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attempts'").get();
		expect(row).toBeTruthy();
	});

	test("attempts table has required columns", () => {
		const db = cache.getDb();
		const cols = db.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);
		expect(names).toContain("id");
		expect(names).toContain("session_id");
		expect(names).toContain("goal_id");
		expect(names).toContain("iteration");
		expect(names).toContain("action");
		expect(names).toContain("target");
		expect(names).toContain("rationale");
		expect(names).toContain("outcome");
		expect(names).toContain("evidence");
		expect(names).toContain("error_pattern");
		expect(names).toContain("created_at");
		expect(names).toContain("turn");
		expect(names).toContain("goal_open");
		expect(names).toContain("pinned");
	});

	test("attempts indexes exist", () => {
		const db = cache.getDb();
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attempts'")
			.all() as Array<{ name: string }>;
		const names = indexes.map((i) => i.name);
		expect(names).toContain("idx_attempts_goal");
		expect(names).toContain("idx_attempts_session");
		expect(names).toContain("idx_attempts_outcome");
		expect(names).toContain("idx_attempts_open");
	});

	test("outcome CHECK constraint rejects invalid values", () => {
		const db = cache.getDb();
		expect(() => {
			db.prepare(
				"INSERT INTO attempts (id, session_id, goal_id, iteration, action, outcome, created_at, turn) VALUES (?,?,?,?,?,?,?,?)",
			).run("x", "s", "g", 1, "bash", "invalid", Date.now(), 1);
		}).toThrow();
	});
});

// ─── D.1.2 — AttemptStore CRUD ───────────────────────────────────────────────

describe("D.1.2 AttemptStore CRUD", () => {
	let testDir: string;
	let cache: ContextCache;
	let store: AttemptStore;

	beforeEach(() => {
		testDir = join(process.cwd(), `.test-attempts-crud-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		cache = new ContextCache(join(testDir, "test.db"));
		store = new AttemptStore(cache.getDb());
	});

	afterEach(() => {
		cache.close();
		rmSync(testDir, { recursive: true });
	});

	test("put and get round-trip", () => {
		const record = makeRecord({ target: "src/foo.ts", rationale: "checking types" });
		store.put(record);
		const got = store.get(record.id);
		expect(got).not.toBeNull();
		expect(got!.id).toBe(record.id);
		expect(got!.target).toBe("src/foo.ts");
		expect(got!.rationale).toBe("checking types");
		expect(got!.goalOpen).toBe(true);
		expect(got!.pinned).toBe(false);
	});

	test("get returns null for unknown id", () => {
		expect(store.get("does-not-exist")).toBeNull();
	});

	test("getByGoal returns all records for a goal in turn order", () => {
		const r1 = makeRecord({ goalId: "goal-A", turn: 1 });
		const r2 = makeRecord({ goalId: "goal-A", turn: 3 });
		const r3 = makeRecord({ goalId: "goal-B", turn: 2 });
		store.put(r1);
		store.put(r2);
		store.put(r3);

		const results = store.getByGoal("goal-A");
		expect(results).toHaveLength(2);
		expect(results[0].turn).toBe(1);
		expect(results[1].turn).toBe(3);
	});

	test("getOpenByGoal returns only open attempts", () => {
		const open = makeRecord({ goalId: "goal-X", turn: 1, goalOpen: true });
		const closed = makeRecord({ goalId: "goal-X", turn: 2, goalOpen: false });
		store.put(open);
		store.put(closed);

		const results = store.getOpenByGoal("goal-X");
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(open.id);
	});

	test("markResolved sets goal_open = 0 for all attempts", () => {
		const r1 = makeRecord({ goalId: "goal-Z", turn: 1 });
		const r2 = makeRecord({ goalId: "goal-Z", turn: 2 });
		store.put(r1);
		store.put(r2);

		const changed = store.markResolved("goal-Z");
		expect(changed).toBe(2);

		const open = store.getOpenByGoal("goal-Z");
		expect(open).toHaveLength(0);
	});

	test("countByGoal returns correct count", () => {
		store.put(makeRecord({ goalId: "goal-C", turn: 1 }));
		store.put(makeRecord({ goalId: "goal-C", turn: 2 }));
		store.put(makeRecord({ goalId: "goal-D", turn: 1 }));

		expect(store.countByGoal("goal-C")).toBe(2);
		expect(store.countByGoal("goal-D")).toBe(1);
		expect(store.countByGoal("goal-E")).toBe(0);
	});

	test("delete removes the record", () => {
		const r = makeRecord();
		store.put(r);
		store.delete(r.id);
		expect(store.get(r.id)).toBeNull();
	});

	test("getBySession returns all records for a session", () => {
		const r1 = makeRecord({ sessionId: "sess-1", turn: 1 });
		const r2 = makeRecord({ sessionId: "sess-1", turn: 2 });
		const r3 = makeRecord({ sessionId: "sess-2", turn: 1 });
		store.put(r1);
		store.put(r2);
		store.put(r3);

		const results = store.getBySession("sess-1");
		expect(results).toHaveLength(2);
	});

	test("optional fields survive null round-trip", () => {
		const r = makeRecord({ target: undefined, rationale: undefined, evidence: undefined });
		store.put(r);
		const got = store.get(r.id);
		expect(got!.target).toBeUndefined();
		expect(got!.rationale).toBeUndefined();
		expect(got!.evidence).toBeUndefined();
	});

	test("put overwrites on duplicate id (INSERT OR REPLACE)", () => {
		const r = makeRecord({ outcome: "fail" });
		store.put(r);
		store.put({ ...r, outcome: "pass" });
		const got = store.get(r.id);
		expect(got!.outcome).toBe("pass");
	});
});

// ─── D.1.3 — normalizeError ───────────────────────────────────────────────────

describe("D.1.3 normalizeError", () => {
	test("Rule 1a: strips 'at line N' references", () => {
		const result = normalizeError(makeText("SyntaxError at line 45 in file"));
		expect(result).toContain("at line n");
		expect(result).not.toMatch(/at line \d/);
	});

	test("Rule 1b: strips file:line:col notation", () => {
		const result = normalizeError(makeText("src/foo.ts:45:3: error TS2322"));
		expect(result).toContain(":n:n");
		expect(result).not.toMatch(/:\d+:\d+/);
	});

	test("Rule 2: anonymizes absolute paths, keeps filename", () => {
		const result = normalizeError(makeText("Error in /home/user/project/src/auth.ts"));
		expect(result).toContain("<path>/auth.ts");
		expect(result).not.toContain("/home/user");
	});

	test("Rule 3: normalizes property access errors", () => {
		const result = normalizeError(makeText("TypeError: Cannot read property 'user' of undefined"));
		expect(result).toContain("property-access-error");
	});

	test("Rule 3: normalizes properties (plural) access errors", () => {
		const result = normalizeError(makeText("TypeError: Cannot read properties 'user' of undefined"));
		expect(result).toContain("property-access-error");
	});

	test("Rule 4: normalizes whitespace", () => {
		const result = normalizeError(makeText("error   with\tmultiple   spaces"));
		expect(result).not.toMatch(/\s{2,}/);
	});

	test("Rule 4: lowercases output", () => {
		const result = normalizeError(makeText("TypeError: UPPER CASE ERROR"));
		expect(result).toBe(result.toLowerCase());
	});

	test("Rule 5: truncates to 200 chars", () => {
		const long = "a".repeat(500);
		const result = normalizeError(makeText(long));
		expect(result.length).toBeLessThanOrEqual(200);
	});

	test("handles empty content", () => {
		const result = normalizeError([]);
		expect(result).toBe("");
	});

	test("ignores non-text content blocks", () => {
		const result = normalizeError([{ type: "image" }, { type: "text", text: "actual error" }]);
		expect(result).toContain("actual error");
	});

	test("combines multiple text blocks", () => {
		const result = normalizeError([
			{ type: "text", text: "first block" },
			{ type: "text", text: "second block" },
		]);
		expect(result).toContain("first block");
		expect(result).toContain("second block");
	});
});

// ─── D.1.4 — detectFailure ───────────────────────────────────────────────────

describe("D.1.4 detectFailure", () => {
	function makeEvent(overrides: {
		toolName?: string;
		input?: Record<string, unknown>;
		content?: Array<{ type: string; text?: string }>;
		isError?: boolean;
	}) {
		return {
			toolName: overrides.toolName ?? "bash",
			input: overrides.input ?? { command: "echo hello" },
			content: overrides.content ?? makeText("some output"),
			isError: overrides.isError ?? false,
		};
	}

	// Path 1: isError flag
	test("Path 1: isError=true -> outcome=fail", () => {
		const result = detectFailure(makeEvent({ isError: true, content: makeText("Permission denied") }));
		expect(result.outcome).toBe("fail");
		expect(result.evidence).toContain("Permission denied");
		expect(result.errorPattern).toBeTruthy();
	});

	// Path 2: bash exit codes
	test("Path 2: non-zero exit code in output -> outcome=fail", () => {
		const result = detectFailure(makeEvent({ content: makeText("Build failed\nexit code: 1") }));
		expect(result.outcome).toBe("fail");
		expect(result.evidence).toContain("Exit code 1");
	});

	test("Path 2: exit code 0 does not trigger fail", () => {
		const result = detectFailure(makeEvent({ content: makeText("exit code: 0\nAll good") }));
		// Should not be a fail from exit code path; may be pass or uncertain from later paths
		expect(result.outcome).not.toBe("fail");
	});

	test("Path 2: bash keyword match without exit code -> uncertain", () => {
		const result = detectFailure(makeEvent({ content: makeText("command failed") }));
		expect(result.outcome).toBe("uncertain");
	});

	test("Path 2: bash success output -> pass", () => {
		const result = detectFailure(makeEvent({ content: makeText("Done in 1.2s") }));
		expect(result.outcome).toBe("pass");
	});

	// Path 3: test runner patterns
	test("Path 3: test runner N failed -> outcome=fail", () => {
		const result = detectFailure(
			makeEvent({
				input: { command: "vitest run" },
				content: makeText("3 failed\n1 passed"),
			}),
		);
		expect(result.outcome).toBe("fail");
		expect(result.evidence).toContain("3 test(s) failed");
	});

	test("Path 3: test runner all passed -> outcome=pass", () => {
		const result = detectFailure(
			makeEvent({
				input: { command: "npm test" },
				content: makeText("5 passed"),
			}),
		);
		expect(result.outcome).toBe("pass");
	});

	test("Path 3: non-test bash is not treated as test runner", () => {
		const result = detectFailure(
			makeEvent({
				input: { command: "echo '3 failed'" },
				content: makeText("3 failed"),
			}),
		);
		// It's bash but not a test runner command — should hit bash keyword uncertain path
		expect(result.outcome).toBe("uncertain");
	});

	// Path 4: common error patterns in any output
	test("Path 4: Error: pattern in non-bash tool -> uncertain", () => {
		const result = detectFailure(
			makeEvent({
				toolName: "read",
				input: {},
				content: makeText("Error: file not found"),
			}),
		);
		expect(result.outcome).toBe("uncertain");
		expect(result.evidence).toBeTruthy();
	});

	test("Path 4: TypeError in non-bash -> uncertain", () => {
		const result = detectFailure(
			makeEvent({
				toolName: "read",
				input: {},
				content: makeText("TypeError: Cannot read property 'x' of null"),
			}),
		);
		expect(result.outcome).toBe("uncertain");
	});

	test("Path 4: FAILED keyword in any output -> uncertain (not fail)", () => {
		const result = detectFailure(
			makeEvent({
				toolName: "read",
				input: {},
				content: makeText("Operation FAILED"),
			}),
		);
		expect(result.outcome).toBe("uncertain");
	});

	// Default: pass
	test("Default: clean output -> pass", () => {
		const result = detectFailure(
			makeEvent({
				toolName: "read",
				input: {},
				content: makeText("file contents here"),
			}),
		);
		expect(result.outcome).toBe("pass");
	});

	test("prefers uncertain over false positive for ambiguous bash", () => {
		// Bash with error keyword but no exit code should be uncertain, not fail
		const result = detectFailure(makeEvent({ content: makeText("some error in the middle") }));
		expect(["uncertain", "pass"]).toContain(result.outcome);
		expect(result.outcome).not.toBe("fail");
	});
});

// ─── isTestRunner ─────────────────────────────────────────────────────────────

describe("isTestRunner", () => {
	test("vitest run is a test runner", () => {
		expect(isTestRunner("bash", { command: "vitest run" })).toBe(true);
	});

	test("npm test is a test runner", () => {
		expect(isTestRunner("bash", { command: "npm test" })).toBe(true);
	});

	test("echo is not a test runner", () => {
		expect(isTestRunner("bash", { command: "echo hello" })).toBe(false);
	});

	test("non-bash tool is not a test runner", () => {
		expect(isTestRunner("read", { command: "vitest run" })).toBe(false);
	});
});

// ─── extractFailedTestNames ───────────────────────────────────────────────────

describe("extractFailedTestNames", () => {
	test("extracts Jest/Vitest FAIL lines", () => {
		const text = "FAIL src/foo.test.ts\nPASS src/bar.test.ts";
		const result = extractFailedTestNames(text);
		expect(result).toContain("src/foo.test.ts");
		expect(result).not.toContain("src/bar.test.ts");
	});

	test("extracts Go --- FAIL lines", () => {
		const text = "--- FAIL: TestFoo (0.01s)\n--- PASS: TestBar (0.02s)";
		const result = extractFailedTestNames(text);
		expect(result).toContain("TestFoo");
	});

	test("caps at 5 names", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `FAIL test_${i}`).join("\n");
		const result = extractFailedTestNames(lines);
		const names = result.split(";").filter(Boolean);
		expect(names.length).toBeLessThanOrEqual(5);
	});

	test("returns empty string when no failures", () => {
		const result = extractFailedTestNames("PASS src/foo.test.ts");
		expect(result).toBe("");
	});
});
