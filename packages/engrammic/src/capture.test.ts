/**
 * Unit tests for capture.ts
 */

import { describe, expect, test } from "vitest";
import { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";

describe("getCaptureRule", () => {
	test("Read → episodic with file/read tags", () => {
		const rule = getCaptureRule("Read", { file_path: "/some/file.ts" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["file", "read"]);
	});

	test("WebSearch → fact with web/search tags", () => {
		const rule = getCaptureRule("WebSearch", { query: "test" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("fact");
		expect(rule!.tags).toEqual(["web", "search"]);
	});

	test("WebFetch → fact with web/fetch tags", () => {
		const rule = getCaptureRule("WebFetch", { url: "https://example.com" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("fact");
		expect(rule!.tags).toEqual(["web", "fetch"]);
	});

	test("Bash with grep command → episodic with search/grep tags", () => {
		const rule = getCaptureRule("Bash", { command: "grep -r 'foo' ." });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["search", "grep"]);
	});

	test("Bash with git diff → episodic with git/diff tags", () => {
		const rule = getCaptureRule("Bash", { command: "git diff HEAD~1" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["git", "diff"]);
	});

	test("Bash with git log → episodic with git/history tags", () => {
		const rule = getCaptureRule("Bash", { command: "git log --oneline -10" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["git", "history"]);
	});

	test("Bash with npm install → null", () => {
		const rule = getCaptureRule("Bash", { command: "npm install" });
		expect(rule).toBeNull();
	});

	test("Edit → null", () => {
		const rule = getCaptureRule("Edit", { file_path: "/some/file.ts" });
		expect(rule).toBeNull();
	});

	test("Unknown tool → null", () => {
		const rule = getCaptureRule("Unknown", {});
		expect(rule).toBeNull();
	});

	test("Bash with rg command → episodic with search/grep tags", () => {
		const rule = getCaptureRule("Bash", { command: "rg 'pattern' src/" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["search", "grep"]);
	});

	test("Bash with git show → episodic with git/history tags", () => {
		const rule = getCaptureRule("Bash", { command: "git show abc123" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["git", "history"]);
	});

	test("Bash with piped grep → episodic with search/grep tags", () => {
		const rule = getCaptureRule("Bash", { command: "cat file.txt | grep 'pattern'" });
		expect(rule).toBeTruthy();
		expect(rule!.type).toBe("episodic");
		expect(rule!.tags).toEqual(["search", "grep"]);
	});

	test("Bash with undefined command → null", () => {
		const rule = getCaptureRule("Bash", {});
		expect(rule).toBeNull();
	});

	test("Bash with null args → null", () => {
		const rule = getCaptureRule("Bash", null);
		expect(rule).toBeNull();
	});
});

describe("generateInternalTags", () => {
	test("Read with filepath → includes tool name, dir:, ext:", () => {
		const tags = generateInternalTags("Read", { file_path: "/home/user/src/utils.ts" });
		expect(tags).toContain("read");
		expect(tags.some((t) => t.startsWith("dir:"))).toBe(true);
		expect(tags.some((t) => t.startsWith("ext:"))).toBe(true);
	});

	test("Read with test file → includes 'test' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/utils.test.ts" });
		expect(tags).toContain("test");
	});

	test("Read with src/ file → includes 'source' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/index.ts" });
		expect(tags).toContain("source");
	});

	test("tool name is lowercased in tags", () => {
		const tags = generateInternalTags("Read", {});
		expect(tags).toContain("read");
		expect(tags).not.toContain("Read");
	});

	test("no filepath → only tool name tag", () => {
		const tags = generateInternalTags("Bash", { command: "ls" });
		expect(tags).toEqual(["bash"]);
	});

	test("file in docs/ → includes 'docs' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/docs/guide.md" });
		expect(tags).toContain("docs");
	});

	test("spec file → includes 'test' tag", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/component.spec.ts" });
		expect(tags).toContain("test");
	});

	test("dir tag uses first two path segments", () => {
		const tags = generateInternalTags("Read", { file_path: "/home/user/project/src/file.ts" });
		const dirTag = tags.find((t) => t.startsWith("dir:"));
		expect(dirTag).toBeTruthy();
		expect(dirTag).toBe("dir:home/user");
	});

	test("ext tag reflects file extension", () => {
		const tags = generateInternalTags("Read", { file_path: "/project/src/file.ts" });
		expect(tags).toContain("ext:ts");
	});
});

describe("extractContent", () => {
	test("empty array → empty string", () => {
		expect(extractContent([])).toBe("");
	});

	test("text content → extracts text", () => {
		const result = extractContent([{ type: "text", text: "hello world" }]);
		expect(result).toBe("hello world");
	});

	test("mixed content → only text, joined with newlines", () => {
		const content = [
			{ type: "text", text: "first line" },
			{ type: "image", data: "base64data" },
			{ type: "text", text: "second line" },
		];
		const result = extractContent(content);
		expect(result).toBe("first line\nsecond line");
	});

	test("image-only content → empty string", () => {
		const content = [{ type: "image", data: "base64data" }];
		const result = extractContent(content);
		expect(result).toBe("");
	});

	test("text block with no text field → skipped", () => {
		const content = [{ type: "text" }, { type: "text", text: "valid" }];
		const result = extractContent(content);
		expect(result).toBe("valid");
	});
});
