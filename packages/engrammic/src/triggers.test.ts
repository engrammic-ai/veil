import { beforeEach, describe, expect, it } from "vitest";
import { ContextCache, createItem } from "./cache.ts";
import { handleTrigger, isDangerousCommand, type TriggerContext } from "./triggers.ts";

function makeCache(): ContextCache {
	return new ContextCache(":memory:");
}

describe("isDangerousCommand", () => {
	it("flags rm -rf", () => {
		expect(isDangerousCommand("rm -rf /tmp/foo")).toBe(true);
	});

	it("flags rm -r", () => {
		expect(isDangerousCommand("rm -r node_modules")).toBe(true);
	});

	it("flags git reset --hard", () => {
		expect(isDangerousCommand("git reset --hard HEAD")).toBe(true);
	});

	it("flags git clean -fd", () => {
		expect(isDangerousCommand("git clean -fd")).toBe(true);
	});

	it("flags git push --force", () => {
		expect(isDangerousCommand("git push --force origin main")).toBe(true);
	});

	it("flags DROP TABLE", () => {
		expect(isDangerousCommand("DROP TABLE users")).toBe(true);
	});

	it("flags TRUNCATE", () => {
		expect(isDangerousCommand("TRUNCATE my_table")).toBe(true);
	});

	it("allows safe rm", () => {
		expect(isDangerousCommand("rm file.txt")).toBe(false);
	});

	it("allows git status", () => {
		expect(isDangerousCommand("git status")).toBe(false);
	});

	it("allows normal SELECT", () => {
		expect(isDangerousCommand("SELECT * FROM users")).toBe(false);
	});
});

describe("handleTrigger - pre_edit", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	it("returns null when no matching items", () => {
		const result = handleTrigger(cache, { type: "pre_edit", filePath: "src/foo.ts" });
		expect(result).toBeNull();
	});

	it("returns null when filePath is missing", () => {
		const result = handleTrigger(cache, { type: "pre_edit" });
		expect(result).toBeNull();
	});

	it("returns past edits for file up to limit 3", () => {
		// Put 5 items tagged with the file and edit
		for (let i = 0; i < 5; i++) {
			const item = createItem(`Edit attempt ${i} in config.ts`, "episodic", ["file:config.ts", "edit"]);
			cache.put(item);
		}

		const result = handleTrigger(cache, { type: "pre_edit", filePath: "config.ts" });
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(3);
		expect(result!.reason).toContain("config.ts");
	});
});

describe("handleTrigger - pre_bash", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	it("returns null for safe commands", () => {
		const result = handleTrigger(cache, { type: "pre_bash", command: "ls -la" });
		expect(result).toBeNull();
	});

	it("returns null when command is missing", () => {
		const result = handleTrigger(cache, { type: "pre_bash" });
		expect(result).toBeNull();
	});

	it("returns null for dangerous command with no past failures in cache", () => {
		const result = handleTrigger(cache, { type: "pre_bash", command: "rm -rf dist/" });
		expect(result).toBeNull();
	});

	it("returns past bash failures for dangerous command up to limit 2", () => {
		for (let i = 0; i < 4; i++) {
			const item = createItem(`Bash error: rm failed permission denied`, "episodic", ["error", "bash", "shell"]);
			// Simulate negative cognitive weight (failure)
			item.cognitiveWeight = -0.5;
			cache.put(item);
		}

		const result = handleTrigger(cache, { type: "pre_bash", command: "rm -rf /var/tmp" });
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(2);
		expect(result!.reason).toContain("failures");
	});
});

describe("handleTrigger - error_observed", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	it("returns null when errorText is missing", () => {
		const result = handleTrigger(cache, { type: "error_observed" });
		expect(result).toBeNull();
	});

	it("returns null when no similar errors in cache", () => {
		const result = handleTrigger(cache, {
			type: "error_observed",
			errorText: "TypeError: cannot read property undefined",
		});
		expect(result).toBeNull();
	});

	it("returns similar past errors up to limit 2", () => {
		// Insert items that match the error keywords
		const item1 = createItem("TypeError cannot read property undefined at loadConfig line 42", "episodic", ["error"]);
		item1.cognitiveWeight = -0.8;
		cache.put(item1);

		const item2 = createItem("TypeError cannot read property undefined missing import", "episodic", ["error"]);
		item2.cognitiveWeight = -0.6;
		cache.put(item2);

		const result = handleTrigger(cache, {
			type: "error_observed",
			errorText: "TypeError: cannot read property undefined",
		});
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(2);
		expect(result!.reason).toContain("errors");
	});
});

describe("handleTrigger - pre_search", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	it("returns null when searchTerms is missing", () => {
		const result = handleTrigger(cache, { type: "pre_search" });
		expect(result).toBeNull();
	});

	it("returns null when no matching items", () => {
		const result = handleTrigger(cache, { type: "pre_search", searchTerms: "fsrs decay" });
		expect(result).toBeNull();
	});

	it("returns past searches up to limit 2", () => {
		for (let i = 0; i < 4; i++) {
			const item = createItem(`Search result for fsrs decay algorithm`, "episodic", [
				"search",
				"grep",
				"fsrs",
				"decay",
			]);
			cache.put(item);
		}

		const result = handleTrigger(cache, { type: "pre_search", searchTerms: "fsrs decay" });
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(2);
		expect(result!.reason).toContain("fsrs");
	});
});

describe("handleTrigger - goal_changed", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	it("returns null when goalId is missing", () => {
		const result = handleTrigger(cache, { type: "goal_changed" });
		expect(result).toBeNull();
	});

	it("returns null when no items tagged with goal", () => {
		const result = handleTrigger(cache, { type: "goal_changed", goalId: "goal-abc123" });
		expect(result).toBeNull();
	});

	it("returns goal-tagged context up to limit 5", () => {
		for (let i = 0; i < 7; i++) {
			const item = createItem(`Context item for goal-abc123 iteration ${i}`, "episodic", ["goal:goal-abc123"]);
			cache.put(item);
		}

		const result = handleTrigger(cache, { type: "goal_changed", goalId: "goal-abc123" });
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(5);
		expect(result!.reason).toContain("goal-abc123");
	});
});

describe("handleTrigger - file_mentioned", () => {
	let cache: ContextCache;

	beforeEach(() => {
		cache = makeCache();
	});

	it("returns null when filePath is missing", () => {
		const result = handleTrigger(cache, { type: "file_mentioned" });
		expect(result).toBeNull();
	});

	it("returns null when no items tagged with file", () => {
		const result = handleTrigger(cache, { type: "file_mentioned", filePath: "src/unknown.ts" });
		expect(result).toBeNull();
	});

	it("returns known file context up to limit 2", () => {
		for (let i = 0; i < 5; i++) {
			const item = createItem(`Content from harness.ts line ${i}`, "episodic", ["file:src/harness.ts"]);
			cache.put(item);
		}

		const result = handleTrigger(cache, {
			type: "file_mentioned",
			filePath: "src/harness.ts",
		});
		expect(result).not.toBeNull();
		expect(result!.items.length).toBeLessThanOrEqual(2);
		expect(result!.reason).toContain("harness.ts");
	});
});

describe("handleTrigger - checkTriggers integration", () => {
	it("returns null for unknown trigger type", () => {
		const cache = makeCache();
		// Cast to bypass TS — tests robustness against unknown types
		const result = handleTrigger(cache, { type: "unknown_type" as TriggerContext["type"] });
		expect(result).toBeNull();
	});
});
