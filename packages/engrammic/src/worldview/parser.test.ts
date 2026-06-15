import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_MAP, getLanguageForFile, TreeSitterParser } from "./parser.ts";

// Mock web-tree-sitter to avoid WASM initialization issues in tests
vi.mock("web-tree-sitter", () => {
	const mockLanguage = { name: "typescript" };
	const mockTree = { rootNode: { type: "program" } };
	const mockParser = {
		setLanguage: vi.fn(),
		parse: vi.fn(() => mockTree),
	};

	return {
		default: {
			init: vi.fn().mockResolvedValue(undefined),
			Language: {
				load: vi.fn().mockResolvedValue(mockLanguage),
			},
		},
		__mockParser: mockParser,
		__mockTree: mockTree,
		__mockLanguage: mockLanguage,
	};
});

describe("TreeSitterParser", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should initialize without error", async () => {
		const parser = new TreeSitterParser();
		await expect(parser.init()).resolves.not.toThrow();
	});

	it("should return null for unknown extensions", async () => {
		const parser = new TreeSitterParser();
		await parser.init();
		const result = await parser.parse("file.xyz", "content");
		expect(result).toBeNull();
	});

	it("should map extensions to languages correctly", async () => {
		expect(EXTENSION_MAP.ts).toBe("typescript");
		expect(EXTENSION_MAP.py).toBe("python");
		expect(EXTENSION_MAP.rs).toBe("rust");
		expect(EXTENSION_MAP.go).toBe("go");
		expect(EXTENSION_MAP.js).toBe("javascript");
		expect(EXTENSION_MAP.jsx).toBe("javascript");
		expect(EXTENSION_MAP.tsx).toBe("tsx");
		expect(EXTENSION_MAP.xyz).toBeUndefined();
	});

	it("should throw if parse called before init", async () => {
		const parser = new TreeSitterParser();
		await expect(parser.parse("test.ts", "const x = 1")).rejects.toThrow(
			"TreeSitterParser.init() must be called before parse()",
		);
	});

	it("should be idempotent on multiple init calls", async () => {
		const parser = new TreeSitterParser();
		await parser.init();
		await parser.init(); // Should not throw
	});
});

describe("getLanguageForFile", () => {
	it("should return language name for known extension", () => {
		expect(getLanguageForFile("src/main.ts")).toBe("typescript");
		expect(getLanguageForFile("lib/util.py")).toBe("python");
		expect(getLanguageForFile("app/main.go")).toBe("go");
	});

	it("should be case-insensitive", () => {
		expect(getLanguageForFile("main.TS")).toBe("typescript");
		expect(getLanguageForFile("main.PY")).toBe("python");
	});

	it("should return null for unknown extension", () => {
		expect(getLanguageForFile("file.xyz")).toBeNull();
		expect(getLanguageForFile("file")).toBeNull();
	});
});
