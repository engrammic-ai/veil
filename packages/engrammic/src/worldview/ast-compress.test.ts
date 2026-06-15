/**
 * Tests for AST compression (ast-compress.ts).
 *
 * web-tree-sitter is mocked so tests run without WASM. Controlled SyntaxNode
 * shapes exercise the signature extraction and hashing logic directly.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { compressFile, compressFunction, extractSignature, hashImplementation } from "./ast-compress.ts";
import type { SyntaxNode } from "./parser.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("web-tree-sitter", () => {
	const mockLanguage = { name: "typescript" };
	const mockParser = {
		setLanguage: vi.fn(),
		parse: vi.fn(),
	};
	// MockParser must be the default export itself (used as `new P()` in parser.ts).
	const MockParser = Object.assign(
		function MockParser(this: unknown) {
			return mockParser;
		},
		{
			init: vi.fn().mockResolvedValue(undefined),
			Language: { load: vi.fn().mockResolvedValue(mockLanguage) },
		},
	);
	return {
		default: MockParser,
		__mockParser: mockParser,
		__mockLanguage: mockLanguage,
	};
});

// ---------------------------------------------------------------------------
// AST builder helpers (mirrors symbols.test.ts)
// ---------------------------------------------------------------------------

function makeNode(
	type: string,
	text: string,
	startRow: number,
	startCol: number,
	endRow: number,
	endCol: number,
	namedChildren: SyntaxNode[] = [],
): SyntaxNode {
	return {
		type,
		text,
		startPosition: { row: startRow, column: startCol },
		endPosition: { row: endRow, column: endCol },
		children: namedChildren,
		namedChildren,
		parent: null,
	} as SyntaxNode;
}

/**
 * Attach childForFieldName to a node so getFieldChild-style lookups work.
 */
function withFieldMap(node: SyntaxNode, fields: Record<string, SyntaxNode | null>): SyntaxNode {
	(node as any).childForFieldName = (name: string) => fields[name] ?? null;
	return node;
}

function makeTree(rootNode: SyntaxNode, languageName: string) {
	return {
		rootNode,
		language: { name: languageName },
	};
}

// ---------------------------------------------------------------------------
// hashImplementation
// ---------------------------------------------------------------------------

describe("hashImplementation", () => {
	it("returns 8-character hex string", () => {
		const h = hashImplementation("{ return 42; }");
		expect(h).toHaveLength(8);
		expect(h).toMatch(/^[0-9a-f]{8}$/);
	});

	it("is deterministic for the same input", () => {
		const input = "{\n  let x = 1;\n  return x + 1;\n}";
		expect(hashImplementation(input)).toBe(hashImplementation(input));
	});

	it("differs for different implementations", () => {
		expect(hashImplementation("{ return 1; }")).not.toBe(hashImplementation("{ return 2; }"));
	});

	it("matches first 8 chars of sha256", () => {
		const text = "{ foo(); }";
		const expected = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
		expect(hashImplementation(text)).toBe(expected);
	});

	it("handles empty string", () => {
		const h = hashImplementation("");
		expect(h).toHaveLength(8);
		expect(h).toMatch(/^[0-9a-f]{8}$/);
	});
});

// ---------------------------------------------------------------------------
// extractSignature — TypeScript / JavaScript
// ---------------------------------------------------------------------------

describe("extractSignature — TypeScript", () => {
	it("returns null for non-function node types", () => {
		const node = makeNode("identifier", "foo", 0, 0, 0, 3);
		expect(extractSignature(node, "typescript")).toBeNull();
	});

	it("returns null for unsupported language", () => {
		const body = makeNode("statement_block", "{ return 1; }", 0, 20, 0, 33);
		const fn = withFieldMap(makeNode("function_declaration", "function foo() { return 1; }", 0, 0, 0, 28, [body]), {
			body,
		});
		expect(extractSignature(fn, "cobol")).toBeNull();
	});

	it("extracts signature from single-line function_declaration", () => {
		// function foo(x: number): number { return x; }
		// 0         1         2         3         4
		// 0123456789012345678901234567890123456789012345
		const body = makeNode("statement_block", "{ return x; }", 0, 32, 0, 45);
		const fn = withFieldMap(
			makeNode("function_declaration", "function foo(x: number): number { return x; }", 0, 0, 0, 45, [body]),
			{ body },
		);
		const sig = extractSignature(fn, "typescript");
		expect(sig).toBe("function foo(x: number): number");
	});

	it("extracts signature from multi-line function declaration", () => {
		const src = `function bar(\n  a: string,\n  b: number\n): void {\n  console.log(a, b);\n}`;
		// The body "{" starts at row 3, col 8
		const body = makeNode("statement_block", "{\n  console.log(a, b);\n}", 3, 8, 5, 1);
		const fn = withFieldMap(makeNode("function_declaration", src, 0, 0, 5, 1, [body]), { body });
		const sig = extractSignature(fn, "typescript");
		// Should be everything before the opening brace on row 3
		expect(sig).toBe("function bar(\n  a: string,\n  b: number\n): void");
	});

	it("extracts signature from method_definition", () => {
		const body = makeNode("statement_block", "{ return this.x; }", 0, 20, 0, 38);
		const method = withFieldMap(
			makeNode("method_definition", "getX(): number { return this.x; }", 0, 0, 0, 32, [body]),
			{ body },
		);
		const sig = extractSignature(method, "typescript");
		expect(sig).toBe("getX(): number");
	});

	it("falls back to named-child scan when childForFieldName absent", () => {
		// No childForFieldName — relies on type-based scan
		const body = makeNode("statement_block", "{ return 1; }", 0, 15, 0, 28);
		const fn = makeNode("function_declaration", "function fn() { return 1; }", 0, 0, 0, 27, [body]);
		const sig = extractSignature(fn, "typescript");
		expect(sig).toBe("function fn()");
	});

	it("returns full node text when no body found (abstract decl)", () => {
		// A function node with no statement_block child
		const fn = makeNode("function_declaration", "function abs(): void", 0, 0, 0, 20);
		const sig = extractSignature(fn, "typescript");
		expect(sig).toBe("function abs(): void");
	});
});

// ---------------------------------------------------------------------------
// extractSignature — Python
// ---------------------------------------------------------------------------

describe("extractSignature — Python", () => {
	it("extracts signature from function_definition", () => {
		// def greet(name: str) -> str:\n    return f"hello {name}"
		const body = makeNode("block", '    return f"hello {name}"', 1, 0, 1, 26);
		const fn = withFieldMap(
			makeNode("function_definition", 'def greet(name: str) -> str:\n    return f"hello {name}"', 0, 0, 1, 26, [
				body,
			]),
			{ body },
		);
		const sig = extractSignature(fn, "python");
		// body is at row 1 col 0, so sig = row 0 full line = "def greet(name: str) -> str:"
		expect(sig).toBe("def greet(name: str) -> str:");
	});

	it("extracts signature from async_function_definition", () => {
		const body = makeNode("block", "    pass", 1, 0, 1, 8);
		const fn = withFieldMap(
			makeNode("async_function_definition", "async def fetch() -> None:\n    pass", 0, 0, 1, 8, [body]),
			{ body },
		);
		const sig = extractSignature(fn, "python");
		expect(sig).toBe("async def fetch() -> None:");
	});
});

// ---------------------------------------------------------------------------
// extractSignature — Go
// ---------------------------------------------------------------------------

describe("extractSignature — Go", () => {
	it("extracts signature from function_declaration", () => {
		// func Add(a, b int) int { return a + b }
		const body = makeNode("block", "{ return a + b }", 0, 24, 0, 40);
		const fn = withFieldMap(
			makeNode("function_declaration", "func Add(a, b int) int { return a + b }", 0, 0, 0, 39, [body]),
			{ body },
		);
		const sig = extractSignature(fn, "go");
		expect(sig).toBe("func Add(a, b int) int");
	});

	it("extracts signature from method_declaration", () => {
		const body = makeNode("block", "{ return s.name }", 0, 26, 0, 43);
		const method = withFieldMap(
			makeNode("method_declaration", "func (s Server) Name() string { return s.name }", 0, 0, 0, 47, [body]),
			{ body },
		);
		const sig = extractSignature(method, "go");
		expect(sig).toBe("func (s Server) Name() string");
	});
});

// ---------------------------------------------------------------------------
// compressFunction
// ---------------------------------------------------------------------------

describe("compressFunction", () => {
	it("returns null for non-function node", () => {
		const node = makeNode("identifier", "foo", 0, 0, 0, 3);
		expect(compressFunction(node, "const foo = 1", "typescript")).toBeNull();
	});

	it("returns null when no body found", () => {
		const fn = makeNode("function_declaration", "function abs(): void", 0, 0, 0, 20);
		// extractSignature would return the full text, but compressFunction also
		// needs a body node to hash — so it should return null.
		expect(compressFunction(fn, "function abs(): void", "typescript")).toBeNull();
	});

	it("returns `signature [IMPL:hash]` for a valid function", () => {
		const content = "function foo(x: number): number { return x * 2; }";
		const body = makeNode("statement_block", "{ return x * 2; }", 0, 32, 0, 49);
		const fn = withFieldMap(makeNode("function_declaration", content, 0, 0, 0, 49, [body]), { body });

		const result = compressFunction(fn, content, "typescript");
		expect(result).not.toBeNull();
		expect(result).toMatch(/^function foo\(x: number\): number \[IMPL:[0-9a-f]{8}\]$/);
	});

	it("hash reflects actual body content", () => {
		const content = "function fn() { return 1; }";
		const bodyText = "{ return 1; }";
		const body = makeNode("statement_block", bodyText, 0, 14, 0, 27);
		const fn = withFieldMap(makeNode("function_declaration", content, 0, 0, 0, 27, [body]), { body });

		const result = compressFunction(fn, content, "typescript");
		const expectedHash = hashImplementation(bodyText);
		expect(result).toBe(`function fn() [IMPL:${expectedHash}]`);
	});

	it("different bodies produce different hashes", () => {
		const makeCompressed = (bodyText: string, _sigEnd: number) => {
			const content = `function f() ${bodyText}`;
			const body = makeNode("statement_block", bodyText, 0, 13, 0, 13 + bodyText.length);
			const fn = withFieldMap(makeNode("function_declaration", content, 0, 0, 0, content.length, [body]), { body });
			return compressFunction(fn, content, "typescript");
		};

		const r1 = makeCompressed("{ return 1; }", 13);
		const r2 = makeCompressed("{ return 2; }", 13);
		expect(r1).not.toBe(r2);
	});
});

// ---------------------------------------------------------------------------
// compressFile
// ---------------------------------------------------------------------------

describe("compressFile", () => {
	async function makeParser(tree: ReturnType<typeof makeTree> | null) {
		const { TreeSitterParser } = await import("./parser.ts");
		const mod = await import("web-tree-sitter");
		const mockParser = (mod as any).__mockParser;
		mockParser.parse.mockReturnValue(tree);

		const parser = new TreeSitterParser();
		await parser.init();
		return parser;
	}

	it("returns content unchanged for unrecognized extension", async () => {
		const { TreeSitterParser } = await import("./parser.ts");
		const parser = new TreeSitterParser();
		await parser.init();

		const content = "some random content";
		const result = await compressFile("file.xyz", content, parser);
		expect(result).toBe(content);
	});

	it("returns content unchanged when parse returns null", async () => {
		const parser = await makeParser(null);
		const content = "function foo() { return 1; }";
		const result = await compressFile("file.ts", content, parser);
		expect(result).toBe(content);
	});

	it("returns content unchanged for file with no functions", async () => {
		const root = makeNode("program", "const x = 1;", 0, 0, 0, 12);
		const tree = makeTree(root, "typescript");
		const parser = await makeParser(tree);

		const content = "const x = 1;";
		const result = await compressFile("file.ts", content, parser);
		expect(result).toBe(content);
	});

	it("compresses a top-level function", async () => {
		// Content: "function foo() { return 1; }"
		const content = "function foo() { return 1; }";
		const bodyText = "{ return 1; }";
		const body = makeNode("statement_block", bodyText, 0, 15, 0, 28);
		const fn = withFieldMap(makeNode("function_declaration", content, 0, 0, 0, 28, [body]), { body });
		const root = makeNode("program", content, 0, 0, 0, 28, [fn]);
		const tree = makeTree(root, "typescript");
		const parser = await makeParser(tree);

		const result = await compressFile("file.ts", content, parser);
		const expectedHash = hashImplementation(bodyText);
		expect(result).toContain(`[IMPL:${expectedHash}]`);
		expect(result).toContain("function foo()");
		// Should NOT contain the original body
		expect(result).not.toContain("return 1");
	});

	it("preserves lines outside function nodes", async () => {
		// File has a comment on line 0, function on line 1
		const content = "// top comment\nfunction foo() { return 1; }";
		const bodyText = "{ return 1; }";
		// Function starts at row 1, col 0; body at row 1, col 15
		const body = makeNode("statement_block", bodyText, 1, 15, 1, 28);
		const fn = withFieldMap(makeNode("function_declaration", "function foo() { return 1; }", 1, 0, 1, 28, [body]), {
			body,
		});
		const root = makeNode("program", content, 0, 0, 1, 28, [fn]);
		const tree = makeTree(root, "typescript");
		const parser = await makeParser(tree);

		const result = await compressFile("file.ts", content, parser);
		expect(result).toContain("// top comment");
		expect(result).toContain("function foo()");
	});
});
