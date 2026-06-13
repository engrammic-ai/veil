/**
 * Unit tests for capture.ts
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";

describe("getCaptureRule", () => {
	test("Read → episodic with file/read tags", () => {
		const rule = getCaptureRule("Read", { file_path: "/some/file.ts" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["file", "read"]);
	});

	test("WebSearch → fact with web/search tags", () => {
		const rule = getCaptureRule("WebSearch", { query: "test" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "fact");
		assert.deepStrictEqual(rule.tags, ["web", "search"]);
	});

	test("WebFetch → fact with web/fetch tags", () => {
		const rule = getCaptureRule("WebFetch", { url: "https://example.com" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "fact");
		assert.deepStrictEqual(rule.tags, ["web", "fetch"]);
	});

	test("Bash with grep command → episodic with search/grep tags", () => {
		const rule = getCaptureRule("Bash", { command: "grep -r 'foo' ." });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["search", "grep"]);
	});

	test("Bash with git diff → episodic with git/diff tags", () => {
		const rule = getCaptureRule("Bash", { command: "git diff HEAD~1" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["git", "diff"]);
	});

	test("Bash with git log → episodic with git/history tags", () => {
		const rule = getCaptureRule("Bash", { command: "git log --oneline -10" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["git", "history"]);
	});

	test("Bash with npm install → null", () => {
		const rule = getCaptureRule("Bash", { command: "npm install" });
		assert.strictEqual(rule, null);
	});

	test("Edit → null", () => {
		const rule = getCaptureRule("Edit", { file_path: "/some/file.ts" });
		assert.strictEqual(rule, null);
	});

	test("Unknown tool → null", () => {
		const rule = getCaptureRule("Unknown", {});
		assert.strictEqual(rule, null);
	});

	test("Bash with rg command → episodic with search/grep tags", () => {
		const rule = getCaptureRule("Bash", { command: "rg 'pattern' src/" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["search", "grep"]);
	});

	test("Bash with git show → episodic with git/history tags", () => {
		const rule = getCaptureRule("Bash", { command: "git show abc123" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["git", "history"]);
	});

	test("Bash with piped grep → episodic with search/grep tags", () => {
		const rule = getCaptureRule("Bash", { command: "cat file.txt | grep 'pattern'" });
		assert.ok(rule);
		assert.strictEqual(rule.type, "episodic");
		assert.deepStrictEqual(rule.tags, ["search", "grep"]);
	});

	test("Bash with undefined command → null", () => {
		const rule = getCaptureRule("Bash", {});
		assert.strictEqual(rule, null);
	});

	test("Bash with null args → null", () => {
		const rule = getCaptureRule("Bash", null);
		assert.strictEqual(rule, null);
	});
});

describe("generateInternalTags", () => {
	test("Read with filepath → includes tool name, dir:, ext:", () => {
		const tags = generateInternalTags("Read", { file_path: "/home/user/src/utils.ts" });
		assert.ok(tags.includes("read"));
		assert.ok(tags.some((t) => t.startsWith("dir:")));
		assert.ok(tags.some((t) => t.startsWith("ext:")));
	});

	test("Read with test file → includes 'test' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/utils.test.ts" });
		assert.ok(tags.includes("test"));
	});

	test("Read with src/ file → includes 'source' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/index.ts" });
		assert.ok(tags.includes("source"));
	});

	test("tool name is lowercased in tags", () => {
		const tags = generateInternalTags("Read", {});
		assert.ok(tags.includes("read"));
		assert.ok(!tags.includes("Read"));
	});

	test("no filepath → only tool name tag", () => {
		const tags = generateInternalTags("Bash", { command: "ls" });
		assert.deepStrictEqual(tags, ["bash"]);
	});

	test("file in docs/ → includes 'docs' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/docs/guide.md" });
		assert.ok(tags.includes("docs"));
	});

	test("spec file → includes 'test' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/component.spec.ts" });
		assert.ok(tags.includes("test"));
	});

	test("dir tag uses first two path segments", () => {
		const tags = generateInternalTags("Read", { file_path: "/home/user/project/src/file.ts" });
		const dirTag = tags.find((t) => t.startsWith("dir:"));
		assert.ok(dirTag);
		assert.strictEqual(dirTag, "dir:home/user");
	});

	test("ext tag reflects file extension", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/file.ts" });
		assert.ok(tags.includes("ext:ts"));
	});
});

describe("extractContent", () => {
	test("empty array → empty string", () => {
		assert.strictEqual(extractContent([]), "");
	});

	test("text content → extracts text", () => {
		const result = extractContent([{ type: "text", text: "hello world" }]);
		assert.strictEqual(result, "hello world");
	});

	test("mixed content → only text, joined with newlines", () => {
		const content = [
			{ type: "text", text: "first line" },
			{ type: "image", data: "base64data" },
			{ type: "text", text: "second line" },
		];
		const result = extractContent(content);
		assert.strictEqual(result, "first line\nsecond line");
	});

	test("image-only content → empty string", () => {
		const content = [{ type: "image", data: "base64data" }];
		const result = extractContent(content);
		assert.strictEqual(result, "");
	});

	test("text block with no text field → skipped", () => {
		const content = [{ type: "text" }, { type: "text", text: "valid" }];
		const result = extractContent(content);
		assert.strictEqual(result, "valid");
	});
});
