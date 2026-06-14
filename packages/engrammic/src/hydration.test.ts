// packages/engrammic/src/hydration.test.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectStubs, formatHydratedBlock, hydrateStub, parseStub } from "./hydration.ts";
import type { ContextItem } from "./types.ts";

describe("parseStub", () => {
	test("parses EPISODE stub with summary", () => {
		const result = parseStub("[EPISODE:abc123:explored auth flow]");
		expect(result).toBeTruthy();
		expect(result!.type).toBe("EPISODE");
		expect(result!.id).toBe("abc123");
		expect(result!.summary).toBe("explored auth flow");
	});

	test("parses FACT stub without summary", () => {
		const result = parseStub("[FACT:xyz789]");
		expect(result).toBeTruthy();
		expect(result!.type).toBe("FACT");
		expect(result!.id).toBe("xyz789");
		expect(result!.summary).toBeUndefined();
	});

	test("parses FILE stub with line range", () => {
		const result = parseStub("[FILE:src/auth.ts:45-80]");
		expect(result).toBeTruthy();
		expect(result!.type).toBe("FILE");
		expect(result!.path).toBe("src/auth.ts");
		expect(result!.lines).toEqual({ start: 45, end: 80 });
	});

	test("parses FILE stub without line range", () => {
		const result = parseStub("[FILE:src/index.ts]");
		expect(result).toBeTruthy();
		expect(result!.type).toBe("FILE");
		expect(result!.path).toBe("src/index.ts");
		expect(result!.lines).toBeUndefined();
	});

	test("returns null for invalid stub", () => {
		expect(parseStub("not a stub")).toBeNull();
		expect(parseStub("[INVALID:foo]")).toBeNull();
	});
});

describe("detectStubs", () => {
	test("detects multiple stubs in text", () => {
		const text = "Looking at [EPISODE:abc:summary] and [FACT:def:another], I see...";
		const stubs = detectStubs(text);
		expect(stubs).toHaveLength(2);
		expect(stubs[0].id).toBe("abc");
		expect(stubs[1].id).toBe("def");
	});

	test("returns empty array for no stubs", () => {
		const stubs = detectStubs("No stubs here");
		expect(stubs).toHaveLength(0);
	});
});

describe("hydrateStub", () => {
	test("hydrates from cache", () => {
		const mockCache = {
			get: (id: string) => (id === "abc" ? ({ content: "Full content here" } as ContextItem) : null),
		};

		const parsed = parseStub("[EPISODE:abc:summary]")!;
		const result = hydrateStub(parsed, mockCache);

		expect(result.content).toBe("Full content here");
		expect(result.error).toBeUndefined();
	});

	test("returns error for missing item", () => {
		const mockCache = { get: () => null };
		const parsed = parseStub("[EPISODE:missing:summary]")!;
		const result = hydrateStub(parsed, mockCache);

		expect(result.error).toBeTruthy();
		expect(result.error).toContain("not found");
	});
});

describe("hydrateStub FILE", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "hydration-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("hydrates file from disk", () => {
		const filePath = join(tmpDir, "test.ts");
		writeFileSync(filePath, "line 1\nline 2\nline 3\nline 4\nline 5");

		const parsed = parseStub(`[FILE:${filePath}:2-4]`)!;
		const result = hydrateStub(parsed, { get: () => null });

		expect(result.content).toBe("line 2\nline 3\nline 4");
		expect(result.error).toBeUndefined();
	});

	test("returns error for missing file", () => {
		const parsed = parseStub("[FILE:/nonexistent/file.ts]")!;
		const result = hydrateStub(parsed, { get: () => null });

		expect(result.error).toContain("File not found");
	});
});

describe("formatHydratedBlock", () => {
	test("formats hydrated content", () => {
		const stubs = [
			{
				stub: parseStub("[EPISODE:abc:summary]")!,
				result: { content: "Full content" } as const,
			},
		];
		const block = formatHydratedBlock(stubs);

		expect(block).toContain("<veil-hydrated>");
		expect(block).toContain("[ref: [EPISODE:abc:summary]]");
		expect(block).toContain("Full content");
		expect(block).toContain("</veil-hydrated>");
	});

	test("formats error", () => {
		const stubs = [
			{
				stub: parseStub("[FILE:missing.ts]")!,
				result: { error: "File not found" } as const,
			},
		];
		const block = formatHydratedBlock(stubs);

		expect(block).toContain("Error: File not found");
	});

	test("returns empty string for no stubs", () => {
		const block = formatHydratedBlock([]);
		expect(block).toBe("");
	});
});
