import { describe, expect, it } from "vitest";
import { normalizeCapture } from "./capture-document.ts";
import type { EnhancedCaptureRule, ExtractorResult } from "./extractors/types.ts";

function rule(overrides: Partial<EnhancedCaptureRule> = {}): EnhancedCaptureRule {
	return {
		type: "episodic",
		tags: ["file", "edit"],
		extractor: "edit",
		maxTokens: 200,
		priority: "normal",
		...overrides,
	};
}

function extracted(overrides: Partial<ExtractorResult> = {}): ExtractorResult {
	return {
		text: "some extracted content",
		...overrides,
	};
}

describe("normalizeCapture — type mapping", () => {
	it("maps edit tool to edit type", () => {
		const doc = normalizeCapture("edit", { file_path: "src/foo.ts" }, extracted(), rule());
		expect(doc.type).toBe("edit");
	});

	it("maps read tool to read type", () => {
		const doc = normalizeCapture(
			"read",
			{ file_path: "src/bar.ts" },
			extracted(),
			rule({ tags: ["file", "read"], extractor: "read" }),
		);
		expect(doc.type).toBe("read");
	});

	it("maps write tool to write type", () => {
		const doc = normalizeCapture(
			"write",
			{ file_path: "src/baz.ts" },
			extracted(),
			rule({ tags: ["file", "write"], extractor: "write" }),
		);
		expect(doc.type).toBe("write");
	});

	it("maps bash tool to bash type", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "npm test" },
			extracted(),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.type).toBe("bash");
	});

	it("maps agent tool to subagent type", () => {
		const doc = normalizeCapture(
			"agent",
			{ description: "explore codebase" },
			extracted(),
			rule({ tags: ["agent"], extractor: "agent" }),
		);
		expect(doc.type).toBe("subagent");
	});

	it("maps skill tool to skill type", () => {
		const doc = normalizeCapture(
			"skill",
			{ skill: "engrammic-recall" },
			extracted(),
			rule({ tags: ["skill"], extractor: "skill" }),
		);
		expect(doc.type).toBe("skill");
	});

	it("maps mcp__ tool to mcp type", () => {
		const doc = normalizeCapture(
			"mcp__engrammic__recall",
			{},
			extracted(),
			rule({ tags: ["mcp"], extractor: "mcp" }),
		);
		expect(doc.type).toBe("mcp");
	});

	it("maps bash+deps tags to deps type", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "npm install lodash" },
			extracted(),
			rule({ tags: ["deps", "bash"], extractor: "deps" }),
		);
		expect(doc.type).toBe("deps");
	});

	it("maps websearch to search type", () => {
		const doc = normalizeCapture(
			"websearch",
			{ query: "vitest docs" },
			extracted(),
			rule({ tags: ["web", "search"], extractor: "passthrough" }),
		);
		expect(doc.type).toBe("search");
	});
});

describe("normalizeCapture — title extraction", () => {
	it("uses first non-empty line of extracted text as title when short enough", () => {
		const doc = normalizeCapture(
			"edit",
			{ file_path: "src/foo.ts" },
			extracted({ text: "Fix null check in loadConfig\nsome more content" }),
			rule(),
		);
		expect(doc.title).toBe("Fix null check in loadConfig");
	});

	it("generates file-based title when extracted text is empty", () => {
		const doc = normalizeCapture("edit", { file_path: "src/utils.ts" }, extracted({ text: "" }), rule());
		expect(doc.title).toContain("utils.ts");
	});

	it("generates bash title from command when no short first line", () => {
		// Use empty text so first-line heuristic doesn't win
		const doc = normalizeCapture(
			"bash",
			{ command: "npm test -- --watch" },
			extracted({ text: "" }),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.title).toMatch(/Run:/);
		expect(doc.title).toContain("npm test");
	});

	it("generates agent title from description when no short first line", () => {
		const doc = normalizeCapture(
			"agent",
			{ description: "Explore the codebase" },
			extracted({ text: "" }),
			rule({ tags: ["agent"], extractor: "agent" }),
		);
		expect(doc.title).toContain("Explore the codebase");
	});

	it("generates skill title from skill name when no short first line", () => {
		const doc = normalizeCapture(
			"skill",
			{ skill: "engrammic-recall" },
			extracted({ text: "" }),
			rule({ tags: ["skill"], extractor: "skill" }),
		);
		expect(doc.title).toContain("engrammic-recall");
	});
});

describe("normalizeCapture — resource extraction", () => {
	it("sets resource to file path for edit", () => {
		const doc = normalizeCapture("edit", { file_path: "src/foo.ts" }, extracted(), rule());
		expect(doc.resource).toBe("src/foo.ts");
	});

	it("includes line range for edit with start/end line", () => {
		const doc = normalizeCapture(
			"edit",
			{ file_path: "src/foo.ts", start_line: 10, end_line: 20 },
			extracted(),
			rule(),
		);
		expect(doc.resource).toBe("src/foo.ts:10-20");
	});

	it("sets resource to command for bash", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "grep -r pattern src/" },
			extracted({ text: "found match" }),
			rule({ tags: ["search", "grep"], extractor: "bash" }),
		);
		expect(doc.resource).toContain("grep -r pattern src/");
	});

	it("sets resource to query for websearch", () => {
		const doc = normalizeCapture(
			"websearch",
			{ query: "vitest mocking" },
			extracted(),
			rule({ tags: ["web", "search"], extractor: "passthrough" }),
		);
		expect(doc.resource).toBe("vitest mocking");
	});

	it("sets resource to undefined for agent (no standard resource)", () => {
		const doc = normalizeCapture(
			"agent",
			{ description: "test" },
			extracted(),
			rule({ tags: ["agent"], extractor: "agent" }),
		);
		expect(doc.resource).toBeUndefined();
	});
});

describe("normalizeCapture — links", () => {
	it("adds file link for edit captures", () => {
		const doc = normalizeCapture("edit", { file_path: "src/utils.ts" }, extracted(), rule());
		const fileLinks = doc.links.filter((l) => l.rel === "file");
		expect(fileLinks.some((l) => l.target === "src/utils.ts")).toBe(true);
	});

	it("adds file link for read captures", () => {
		const doc = normalizeCapture(
			"read",
			{ file_path: "packages/ai/src/index.ts" },
			extracted(),
			rule({ tags: ["file", "read"], extractor: "read" }),
		);
		const fileLinks = doc.links.filter((l) => l.rel === "file");
		expect(fileLinks.some((l) => l.target === "packages/ai/src/index.ts")).toBe(true);
	});

	it("extracts file paths mentioned in text as file links", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "grep -r foo src/" },
			extracted({ text: "src/utils.ts:42: const foo = 1;\npackages/agent/src/runner.ts:10: import foo" }),
			rule({ tags: ["search", "grep"], extractor: "bash" }),
		);
		const targets = doc.links.map((l) => l.target);
		expect(targets.some((t) => t.includes("utils.ts"))).toBe(true);
	});

	it("does not duplicate primary resource in file links", () => {
		const doc = normalizeCapture(
			"edit",
			{ file_path: "src/foo.ts" },
			extracted({ text: "content referencing src/foo.ts again" }),
			rule(),
		);
		const fooLinks = doc.links.filter((l) => l.target === "src/foo.ts");
		expect(fooLinks.length).toBe(1);
	});
});

describe("normalizeCapture — outcome detection", () => {
	it("detects success from exitCode 0", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "npm test", exitCode: 0 },
			extracted({ text: "all tests passed" }),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.outcome).toBe("success");
		expect(doc.exitCode).toBe(0);
	});

	it("detects failure from non-zero exitCode", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "npm test", exitCode: 1 },
			extracted({ text: "2 tests failed" }),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.outcome).toBe("failure");
		expect(doc.exitCode).toBe(1);
	});

	it("detects failure from text patterns when no exitCode", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "tsc" },
			extracted({ text: "SyntaxError: unexpected token" }),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.outcome).toBe("failure");
	});

	it("detects success from text pattern when no exitCode", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "npm test" },
			extracted({ text: "all tests passed, 0 errors" }),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.outcome).toBe("success");
	});

	it("returns undefined outcome for edit without clues", () => {
		const doc = normalizeCapture("edit", { file_path: "src/foo.ts" }, extracted(), rule());
		expect(doc.outcome).toBeUndefined();
	});
});

describe("normalizeCapture — tags", () => {
	it("includes rule tags in output tags", () => {
		const doc = normalizeCapture("edit", { file_path: "src/foo.ts" }, extracted(), rule({ tags: ["file", "edit"] }));
		expect(doc.tags).toContain("file");
		expect(doc.tags).toContain("edit");
	});

	it("merges extractor extraTags into document tags", () => {
		const doc = normalizeCapture(
			"bash",
			{ command: "tsc" },
			extracted({ text: "TypeError: ...", extraTags: ["error:TypeError"] }),
			rule({ tags: ["test", "bash"], extractor: "bash" }),
		);
		expect(doc.tags).toContain("error:TypeError");
	});
});

describe("normalizeCapture — body", () => {
	it("sets body to extracted text", () => {
		const doc = normalizeCapture(
			"edit",
			{ file_path: "src/foo.ts" },
			extracted({ text: "my extracted content" }),
			rule(),
		);
		expect(doc.body).toBe("my extracted content");
	});
});

describe("normalizeCapture — timestamp", () => {
	it("uses provided timestamp", () => {
		const ts = new Date("2026-06-19T14:30:00Z").getTime();
		const doc = normalizeCapture("edit", { file_path: "src/foo.ts" }, extracted(), rule(), ts);
		expect(doc.timestamp).toBe("2026-06-19T14:30:00.000Z");
	});

	it("uses current time when no timestamp given", () => {
		const before = Date.now();
		const doc = normalizeCapture("edit", { file_path: "src/foo.ts" }, extracted(), rule());
		const after = Date.now();
		const ts = new Date(doc.timestamp).getTime();
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});
});
