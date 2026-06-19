import { describe, expect, it } from "vitest";
import { bashExtractor } from "./bash.ts";
import { depsExtractor } from "./deps.ts";
import { editExtractor } from "./edit.ts";
import { mcpExtractor } from "./mcp.ts";
import { readExtractor } from "./read.ts";
import { skillExtractor } from "./skill.ts";
import { subagentExtractor } from "./subagent.ts";
import type { ExtractorContext } from "./types.ts";
import { writeExtractor } from "./write.ts";

function ctx(overrides: Partial<ExtractorContext> & { args?: Record<string, unknown> }): ExtractorContext {
	return {
		toolName: "Test",
		args: {},
		content: "",
		isError: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// editExtractor
// ---------------------------------------------------------------------------
describe("editExtractor", () => {
	it("captures file edits with path and diff snippets", () => {
		const result = editExtractor(ctx({ args: { file_path: "src/foo.ts", old_string: "old", new_string: "new" } }));
		expect(result.skipCapture).toBeFalsy();
		expect(result.text).toContain("[Edit] src/foo.ts");
		expect(result.text).toContain("-old");
		expect(result.text).toContain("+new");
	});

	it("extracts file extension tag", () => {
		const result = editExtractor(ctx({ args: { file_path: "src/foo.ts", old_string: "", new_string: "" } }));
		expect(result.extraTags).toContain("ext:ts");
	});

	it("truncates old_string and new_string to 200 chars", () => {
		const long = "x".repeat(300);
		const result = editExtractor(ctx({ args: { file_path: "a.ts", old_string: long, new_string: long } }));
		// Each snippet is at most 200 chars (200-3 content + '...')
		const lines = result.text.split("\n");
		const oldLine = lines.find((l) => l.startsWith("-"))!;
		const newLine = lines.find((l) => l.startsWith("+"))!;
		expect(oldLine.slice(1).length).toBeLessThanOrEqual(200);
		expect(newLine.slice(1).length).toBeLessThanOrEqual(200);
	});

	it("includes replace_all note when flag is set", () => {
		const result = editExtractor(
			ctx({ args: { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true } }),
		);
		expect(result.text).toContain("(replace_all)");
	});

	it("skips capture when file_path is not a string", () => {
		const result = editExtractor(ctx({ args: { file_path: null } }));
		expect(result.skipCapture).toBe(true);
	});

	it("skips capture when file_path is missing", () => {
		const result = editExtractor(ctx({ args: {} }));
		expect(result.skipCapture).toBe(true);
	});

	it("produces no extraTags for extension-less file", () => {
		const result = editExtractor(ctx({ args: { file_path: "Makefile", old_string: "", new_string: "" } }));
		expect(result.extraTags).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// bashExtractor
// ---------------------------------------------------------------------------
describe("bashExtractor", () => {
	it("skips low-value successful commands", () => {
		const result = bashExtractor(ctx({ args: { command: "ls -la" } }));
		expect(result.skipCapture).toBe(true);
	});

	it("captures successful npm install", () => {
		const result = bashExtractor(ctx({ args: { command: "npm install express" } }));
		expect(result.skipCapture).toBeFalsy();
		expect(result.text).toContain("[Bash OK]");
		expect(result.text).toContain("npm install express");
	});

	it("captures failure with exit code", () => {
		const result = bashExtractor(
			ctx({ args: { command: "npm run build" }, content: "npm ERR! build failed", isError: true, exitCode: 1 }),
		);
		expect(result.skipCapture).toBeFalsy();
		expect(result.text).toContain("[Bash FAIL exit=1]");
		expect(result.extraTags).toContain("failure");
	});

	it("classifies npm error correctly", () => {
		const result = bashExtractor(
			ctx({
				args: { command: "npm install bad-pkg" },
				content: "npm ERR! 404 Not Found",
				isError: true,
				exitCode: 1,
			}),
		);
		expect(result.extraTags).toContain("error:npm");
	});

	it("classifies ENOENT error", () => {
		const result = bashExtractor(
			ctx({
				args: { command: "cat missing.txt" },
				content: "No such file or directory",
				isError: true,
				exitCode: 1,
			}),
		);
		expect(result.extraTags).toContain("error:ENOENT");
	});

	it("classifies git fatal error", () => {
		const result = bashExtractor(
			ctx({
				args: { command: "git push" },
				content: "fatal: remote rejected",
				isError: true,
				exitCode: 128,
			}),
		);
		expect(result.extraTags).toContain("error:git");
	});

	it("captures successful git commit", () => {
		const result = bashExtractor(
			ctx({ args: { command: "git commit -m 'feat: add tests'" }, content: "[main abc1234]", exitCode: 0 }),
		);
		expect(result.skipCapture).toBeFalsy();
		expect(result.text).toContain("[Bash OK]");
	});

	it("uses isError=true as fallback for exit code", () => {
		const result = bashExtractor(ctx({ args: { command: "npm run build" }, content: "error output", isError: true }));
		expect(result.text).toContain("[Bash FAIL exit=1]");
	});
});

// ---------------------------------------------------------------------------
// readExtractor
// ---------------------------------------------------------------------------
describe("readExtractor", () => {
	it("skips capture when file_path is not a string", () => {
		const result = readExtractor(ctx({ args: { file_path: 42 } }));
		expect(result.skipCapture).toBe(true);
	});

	it("skips capture when file_path is missing", () => {
		const result = readExtractor(ctx({ args: {} }));
		expect(result.skipCapture).toBe(true);
	});

	it("extracts TS export declarations", () => {
		const tsContent = `export const foo = 1;\nexport function bar() {}\nexport class Baz {}`;
		const result = readExtractor(ctx({ args: { file_path: "src/index.ts" }, content: tsContent }));
		expect(result.text).toContain("[Read] src/index.ts");
		expect(result.text).toContain("export const foo");
		expect(result.text).toContain("export function bar");
		expect(result.text).toContain("export class Baz");
		expect(result.extraTags).toContain("ext:ts");
	});

	it("extracts JS export declarations", () => {
		const jsContent = `export function hello() {}\nconst internal = 1;`;
		const result = readExtractor(ctx({ args: { file_path: "lib/utils.js" }, content: jsContent }));
		expect(result.text).toContain("export function hello");
	});

	it("extracts Python def/class signatures", () => {
		const pyContent = `def my_func():\n    pass\n\nclass MyClass:\n    pass\n`;
		const result = readExtractor(ctx({ args: { file_path: "module.py" }, content: pyContent }));
		expect(result.text).toContain("def my_func");
		expect(result.text).toContain("class MyClass");
		expect(result.extraTags).toContain("ext:py");
	});

	it("includes line count in structure", () => {
		const content = "line1\nline2\nline3";
		const result = readExtractor(ctx({ args: { file_path: "src/a.ts" }, content }));
		expect(result.text).toContain("(3 lines)");
	});

	it("falls back to line count for plain text file", () => {
		const result = readExtractor(ctx({ args: { file_path: "notes.txt" }, content: "hello\nworld" }));
		expect(result.text).toContain("[Read] notes.txt");
		expect(result.text).toContain("(2 lines)");
	});

	it("extracts markdown headers", () => {
		const mdContent = `# Title\n## Section\n### Subsection\nsome text`;
		const result = readExtractor(ctx({ args: { file_path: "README.md" }, content: mdContent }));
		expect(result.text).toContain("Title");
		expect(result.text).toContain("Section");
	});
});

// ---------------------------------------------------------------------------
// writeExtractor
// ---------------------------------------------------------------------------
describe("writeExtractor", () => {
	it("captures file write with line count", () => {
		const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
		const result = writeExtractor(ctx({ args: { file_path: "out.ts", content: lines } }));
		expect(result.text).toContain("[Write] out.ts (25 lines)");
	});

	it("includes preview of first 10 lines", () => {
		const content = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
		const result = writeExtractor(ctx({ args: { file_path: "out.ts", content } }));
		expect(result.text).toContain("line0");
		expect(result.text).toContain("line9");
		// line10 and beyond are outside the 10-line preview
		const previewLines = result.text.split("\n").slice(1);
		expect(previewLines.join("\n")).not.toContain("line10");
	});

	it("truncates preview at 300 chars", () => {
		const content = `${"x".repeat(400)}\n${"y".repeat(400)}`;
		const result = writeExtractor(ctx({ args: { file_path: "big.ts", content } }));
		// Preview is everything after first line; should end with ...
		expect(result.text).toContain("...");
	});

	it("includes file extension tag", () => {
		const result = writeExtractor(ctx({ args: { file_path: "src/mod.rs", content: "fn main() {}" } }));
		expect(result.extraTags).toContain("ext:rs");
	});

	it("skips capture when file_path is not a string", () => {
		const result = writeExtractor(ctx({ args: { file_path: 123, content: "data" } }));
		expect(result.skipCapture).toBe(true);
	});

	it("skips capture when content is not a string", () => {
		const result = writeExtractor(ctx({ args: { file_path: "a.ts", content: null } }));
		expect(result.skipCapture).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// subagentExtractor
// ---------------------------------------------------------------------------
describe("subagentExtractor", () => {
	it("captures agent dispatch with truncated prompt", () => {
		const prompt = "Do something important with this long description that goes on and on";
		const result = subagentExtractor(ctx({ args: { prompt, agentType: "Explore" } }));
		expect(result.text).toContain("[Agent Explore] OK");
		expect(result.text).toContain("Do something important");
	});

	it("truncates prompt to 50 chars", () => {
		const prompt = "x".repeat(100);
		const result = subagentExtractor(ctx({ args: { prompt, agentType: "Explore" } }));
		// prompt snippet is 50 chars max (47 + "...")
		const snippetStart = result.text.indexOf(": ") + 2;
		const snippet = result.text.slice(snippetStart);
		expect(snippet.length).toBeLessThanOrEqual(53); // 50 + newline safety
	});

	it("marks failure when isError=true", () => {
		const result = subagentExtractor(ctx({ args: { prompt: "Run task", agentType: "claude" }, isError: true }));
		expect(result.text).toContain("FAILED");
	});

	it("formats duration in seconds", () => {
		const result = subagentExtractor(ctx({ args: { prompt: "Do it", agentType: "Explore", durationMs: 5000 } }));
		expect(result.text).toContain("(5s)");
	});

	it("omits duration when not provided", () => {
		const result = subagentExtractor(ctx({ args: { prompt: "Do it", agentType: "Explore" } }));
		expect(result.text).not.toContain("s)");
	});

	it("falls back to 'default' agent type when agentType missing", () => {
		const result = subagentExtractor(ctx({ args: { prompt: "Task" } }));
		expect(result.text).toContain("[Agent default]");
	});

	it("skips capture when prompt is empty", () => {
		const result = subagentExtractor(ctx({ args: { prompt: "" } }));
		expect(result.skipCapture).toBe(true);
	});

	it("skips capture when prompt is not a string", () => {
		const result = subagentExtractor(ctx({ args: { prompt: null } }));
		expect(result.skipCapture).toBe(true);
	});

	it("includes agentType as extraTag", () => {
		const result = subagentExtractor(ctx({ args: { prompt: "Task", agentType: "Explore" } }));
		expect(result.extraTags).toContain("subagent");
		expect(result.extraTags).toContain("Explore");
	});
});

// ---------------------------------------------------------------------------
// mcpExtractor
// ---------------------------------------------------------------------------
describe("mcpExtractor", () => {
	it("extracts GitHub PR number", () => {
		const result = mcpExtractor(
			ctx({ toolName: "mcp__github__get-pull-request", args: { pull_number: 42, repo: "org/repo" } }),
		);
		expect(result.text).toContain("PR #42");
		expect(result.text).toContain("org/repo");
	});

	it("extracts Notion page ID", () => {
		const result = mcpExtractor(ctx({ toolName: "mcp__notion__get-page", args: { page_id: "abc-123" } }));
		expect(result.text).toContain("abc-123");
	});

	it("uses generic fallback for unknown tool", () => {
		const result = mcpExtractor(ctx({ toolName: "mcp__custom__do-thing", args: { param: "value" } }));
		expect(result.text).toContain("[MCP mcp__custom__do-thing]");
		expect(result.text).toContain("value");
	});

	it("includes mcp tag and tool-derived tag", () => {
		const result = mcpExtractor(ctx({ toolName: "mcp__github__create-pr", args: { pull_number: 1 } }));
		expect(result.extraTags).toContain("mcp");
		expect(result.extraTags).toContain("mcp:github");
	});

	it("marks failure when isError=true", () => {
		const result = mcpExtractor(ctx({ toolName: "mcp__github__get-issue", args: { number: 99 }, isError: true }));
		expect(result.text).toContain("FAILED");
	});

	it("skips capture when toolName is empty", () => {
		const result = mcpExtractor(ctx({ toolName: "", args: {} }));
		expect(result.skipCapture).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// skillExtractor
// ---------------------------------------------------------------------------
describe("skillExtractor", () => {
	it("captures skill name and outcome", () => {
		const result = skillExtractor(ctx({ args: { skill: "engrammic-recall", args: "memory query" } }));
		expect(result.text).toContain("[Skill /engrammic-recall] OK");
		expect(result.extraTags).toContain("skill");
		expect(result.extraTags).toContain("skill:engrammic-recall");
	});

	it("truncates args to 50 chars", () => {
		const longArgs = "x".repeat(100);
		const result = skillExtractor(ctx({ args: { skill: "my-skill", args: longArgs } }));
		const colonIdx = result.text.indexOf(": ");
		const argsSnip = result.text.slice(colonIdx + 2);
		expect(argsSnip.length).toBeLessThanOrEqual(53);
	});

	it("marks failure when isError=true", () => {
		const result = skillExtractor(ctx({ args: { skill: "code-review" }, isError: true }));
		expect(result.text).toContain("FAILED");
	});

	it("omits args section when args not provided", () => {
		const result = skillExtractor(ctx({ args: { skill: "verify" } }));
		expect(result.text).toBe("[Skill /verify] OK");
	});

	it("skips capture when skill is empty string", () => {
		const result = skillExtractor(ctx({ args: { skill: "" } }));
		expect(result.skipCapture).toBe(true);
	});

	it("skips capture when skill is not a string", () => {
		const result = skillExtractor(ctx({ args: { skill: null } }));
		expect(result.skipCapture).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// depsExtractor
// ---------------------------------------------------------------------------
describe("depsExtractor", () => {
	it("extracts npm install packages", () => {
		const result = depsExtractor(ctx({ args: { command: "npm install express lodash" } }));
		expect(result.skipCapture).toBeFalsy();
		expect(result.text).toContain("express");
		expect(result.text).toContain("lodash");
		expect(result.extraTags).toContain("pkg:express");
		expect(result.extraTags).toContain("pkg:lodash");
	});

	it("extracts yarn add packages", () => {
		const result = depsExtractor(ctx({ args: { command: "yarn add react react-dom" } }));
		expect(result.text).toContain("react");
		expect(result.extraTags).toContain("pkg:react");
	});

	it("extracts pip install packages", () => {
		const result = depsExtractor(ctx({ args: { command: "pip install requests numpy" } }));
		expect(result.text).toContain("requests");
		expect(result.text).toContain("numpy");
	});

	it("extracts cargo add packages", () => {
		const result = depsExtractor(ctx({ args: { command: "cargo add serde tokio" } }));
		expect(result.text).toContain("serde");
		expect(result.text).toContain("tokio");
	});

	it("extracts pnpm add packages", () => {
		const result = depsExtractor(ctx({ args: { command: "pnpm add vite" } }));
		expect(result.text).toContain("vite");
	});

	it("skips capture when no packages found", () => {
		const result = depsExtractor(ctx({ args: { command: "npm run build" } }));
		expect(result.skipCapture).toBe(true);
	});

	it("skips capture for plain git command", () => {
		const result = depsExtractor(ctx({ args: { command: "git status" } }));
		expect(result.skipCapture).toBe(true);
	});

	it("marks failure outcome when isError=true", () => {
		const result = depsExtractor(ctx({ args: { command: "npm install bad-pkg" }, isError: true }));
		expect(result.text).toContain("[Deps FAILED]");
	});

	it("strips version suffixes from package names", () => {
		const result = depsExtractor(ctx({ args: { command: "npm install express@4.18.2" } }));
		expect(result.extraTags).toContain("pkg:express");
		expect(result.extraTags).not.toContain("pkg:express@4.18.2");
	});

	it("filters out flag arguments", () => {
		const result = depsExtractor(ctx({ args: { command: "npm install --save-dev typescript" } }));
		expect(result.text).toContain("typescript");
		expect(result.text).not.toContain("--save-dev");
	});
});
