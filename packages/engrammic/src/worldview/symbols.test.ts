/**
 * Tests for symbol extraction (symbols.ts + symbol-store.ts).
 *
 * web-tree-sitter is mocked so tests run without WASM. The mock returns
 * controlled AST shapes that exercise the walker logic.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyntaxNode, Tree } from "./parser.ts";
import { SymbolStore } from "./symbol-store.ts";
import type { ExtractedSymbol } from "./symbols.ts";
import { extractFromTree, SymbolExtractor } from "./symbols.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("web-tree-sitter", () => {
	const mockLanguage = { name: "typescript" };
	const mockParser = {
		setLanguage: vi.fn(),
		parse: vi.fn(),
	};
	const MockParser = Object.assign(
		function MockParserConstructor() {
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
// AST builder helpers
// ---------------------------------------------------------------------------

function makeNode(type: string, text: string, row: number, namedChildren: SyntaxNode[] = []): SyntaxNode {
	return {
		type,
		text,
		startPosition: { row, column: 0 },
		endPosition: { row, column: text.length },
		children: namedChildren,
		namedChildren,
		parent: null,
	} as SyntaxNode;
}

/**
 * Attach childForFieldName to a node so getFieldChild uses the proper API.
 */
function withField(node: SyntaxNode, fieldName: string, child: SyntaxNode): SyntaxNode {
	(node as any).childForFieldName = (name: string) => (name === fieldName ? child : null);
	return node;
}

function makeTree(rootNode: SyntaxNode, languageName: string): Tree {
	return {
		rootNode,
		language: { name: languageName },
	};
}

// ---------------------------------------------------------------------------
// extractFromTree tests
// ---------------------------------------------------------------------------

describe("extractFromTree — TypeScript", () => {
	it("extracts a function_declaration def", () => {
		const nameNode = makeNode("identifier", "myFunction", 2);
		const funcNode = withField(
			makeNode("function_declaration", "function myFunction() {}", 2, [nameNode]),
			"name",
			nameNode,
		);
		const root = makeNode("program", "", 0, [funcNode]);
		const tree = makeTree(root, "typescript");

		const symbols = extractFromTree(tree, "typescript");
		const defs = symbols.filter((s) => s.kind === "def");
		expect(defs).toContainEqual({ symbol: "myFunction", kind: "def", line: 3 });
	});

	it("extracts a class_declaration def", () => {
		const nameNode = makeNode("identifier", "MyClass", 5);
		const classNode = withField(makeNode("class_declaration", "class MyClass {}", 5, [nameNode]), "name", nameNode);
		const root = makeNode("program", "", 0, [classNode]);
		const tree = makeTree(root, "typescript");

		const symbols = extractFromTree(tree, "typescript");
		expect(symbols).toContainEqual({ symbol: "MyClass", kind: "def", line: 6 });
	});

	it("extracts an interface_declaration def", () => {
		const nameNode = makeNode("type_identifier", "IFoo", 10);
		const iface = withField(makeNode("interface_declaration", "interface IFoo {}", 10, [nameNode]), "name", nameNode);
		const root = makeNode("program", "", 0, [iface]);
		const tree = makeTree(root, "typescript");

		const symbols = extractFromTree(tree, "typescript");
		expect(symbols).toContainEqual({ symbol: "IFoo", kind: "def", line: 11 });
	});

	it("extracts refs to known def names", () => {
		// Def: function myFunc on line 0
		const nameNode = makeNode("identifier", "myFunc", 0);
		const funcNode = withField(
			makeNode("function_declaration", "function myFunc() {}", 0, [nameNode]),
			"name",
			nameNode,
		);

		// Ref: identifier "myFunc" on line 5
		const refNode = makeNode("identifier", "myFunc", 5);

		const root = makeNode("program", "", 0, [funcNode, refNode]);
		const tree = makeTree(root, "typescript");

		const symbols = extractFromTree(tree, "typescript");
		const refs = symbols.filter((s) => s.kind === "ref");
		expect(refs.some((r) => r.symbol === "myFunc" && r.line === 6)).toBe(true);
	});

	it("does not emit ref on the same line as def", () => {
		const nameNode = makeNode("identifier", "fn", 2);
		const funcNode = withField(makeNode("function_declaration", "function fn() {}", 2, [nameNode]), "name", nameNode);
		// Ref on same line
		const refNode = makeNode("identifier", "fn", 2);

		const root = makeNode("program", "", 0, [funcNode, refNode]);
		const tree = makeTree(root, "typescript");

		const symbols = extractFromTree(tree, "typescript");
		// Should have def at line 3 but no ref at line 3
		const refsOnDefLine = symbols.filter((s) => s.kind === "ref" && s.line === 3);
		expect(refsOnDefLine).toHaveLength(0);
	});

	it("returns empty array for unsupported language", () => {
		const root = makeNode("program", "", 0, []);
		const tree = makeTree(root, "cobol");
		expect(extractFromTree(tree, "cobol")).toHaveLength(0);
	});

	it("deduplicates identical def symbol+line pairs", () => {
		const nameNode = makeNode("identifier", "dup", 0);
		// Two nodes with the same type+name+line (edge case)
		const fn1 = withField(makeNode("function_declaration", "function dup() {}", 0, [nameNode]), "name", nameNode);
		const fn2 = withField(makeNode("function_declaration", "function dup() {}", 0, [nameNode]), "name", nameNode);

		const root = makeNode("program", "", 0, [fn1, fn2]);
		const tree = makeTree(root, "typescript");

		const defs = extractFromTree(tree, "typescript").filter((s) => s.kind === "def" && s.symbol === "dup");
		expect(defs).toHaveLength(1);
	});
});

describe("extractFromTree — Python", () => {
	it("extracts function_definition", () => {
		const nameNode = makeNode("identifier", "my_func", 0);
		const fn = withField(makeNode("function_definition", "def my_func(): ...", 0, [nameNode]), "name", nameNode);
		const root = makeNode("module", "", 0, [fn]);
		const tree = makeTree(root, "python");

		const symbols = extractFromTree(tree, "python");
		expect(symbols).toContainEqual({ symbol: "my_func", kind: "def", line: 1 });
	});

	it("extracts class_definition", () => {
		const nameNode = makeNode("identifier", "MyClass", 3);
		const cls = withField(makeNode("class_definition", "class MyClass: ...", 3, [nameNode]), "name", nameNode);
		const root = makeNode("module", "", 0, [cls]);
		const tree = makeTree(root, "python");

		expect(extractFromTree(tree, "python")).toContainEqual({ symbol: "MyClass", kind: "def", line: 4 });
	});
});

describe("extractFromTree — Go", () => {
	it("extracts function_declaration", () => {
		const nameNode = makeNode("identifier", "MyFunc", 0);
		const fn = withField(makeNode("function_declaration", "func MyFunc() {}", 0, [nameNode]), "name", nameNode);
		const root = makeNode("source_file", "", 0, [fn]);
		const tree = makeTree(root, "go");

		expect(extractFromTree(tree, "go")).toContainEqual({ symbol: "MyFunc", kind: "def", line: 1 });
	});
});

// ---------------------------------------------------------------------------
// SymbolExtractor (integration via mocked parser)
// ---------------------------------------------------------------------------

describe("SymbolExtractor", () => {
	it("returns empty array when parser returns null", async () => {
		// Import the mock and make parse return null
		const mod = await import("web-tree-sitter");
		const mockParser = (mod as any).__mockParser;
		mockParser.parse.mockReturnValue(null);

		// We need TreeSitterParser.parse to return null — achieved by having
		// the language load fail for an unknown extension
		const extractor = new SymbolExtractor();
		await extractor.init();
		// .xyz extension — no language mapping — returns null from parser.parse
		const result = await extractor.extractSymbols("file.xyz", "content");
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// SymbolStore
// ---------------------------------------------------------------------------

describe("SymbolStore", () => {
	let db: Database.Database;
	let store: SymbolStore;

	beforeEach(() => {
		db = new Database(":memory:");
		store = new SymbolStore(db);
	});

	it("upserts and retrieves symbols for a file", () => {
		const syms: ExtractedSymbol[] = [
			{ symbol: "myFunc", kind: "def", line: 1 },
			{ symbol: "MyClass", kind: "def", line: 10 },
			{ symbol: "myFunc", kind: "ref", line: 20 },
		];
		store.upsertSymbols("/src/foo.ts", syms);

		const rows = store.getSymbolsForFile("/src/foo.ts");
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.symbol === "myFunc" && r.kind === "def")).toBeDefined();
		expect(rows.find((r) => r.symbol === "MyClass" && r.kind === "def")).toBeDefined();
		expect(rows.find((r) => r.symbol === "myFunc" && r.kind === "ref")).toBeDefined();
	});

	it("replaces symbols on second upsert (delete-then-insert)", () => {
		store.upsertSymbols("/src/foo.ts", [{ symbol: "oldSym", kind: "def", line: 1 }]);
		store.upsertSymbols("/src/foo.ts", [{ symbol: "newSym", kind: "def", line: 5 }]);

		const rows = store.getSymbolsForFile("/src/foo.ts");
		expect(rows).toHaveLength(1);
		expect(rows[0].symbol).toBe("newSym");
	});

	it("returns empty array for unknown file", () => {
		expect(store.getSymbolsForFile("/nonexistent.ts")).toEqual([]);
	});

	it("getReferencesTo returns files referencing a symbol", () => {
		store.upsertSymbols("/a.ts", [
			{ symbol: "sharedFn", kind: "def", line: 1 },
			{ symbol: "sharedFn", kind: "ref", line: 5 },
		]);
		store.upsertSymbols("/b.ts", [{ symbol: "sharedFn", kind: "ref", line: 3 }]);
		store.upsertSymbols("/c.ts", [{ symbol: "otherFn", kind: "def", line: 1 }]);

		const refs = store.getReferencesTo("sharedFn");
		expect(refs.length).toBe(2);
		expect(refs.some((r) => r.file === "/a.ts" && r.line === 5)).toBe(true);
		expect(refs.some((r) => r.file === "/b.ts" && r.line === 3)).toBe(true);
	});

	it("getReferencesTo returns empty for symbol with no refs", () => {
		store.upsertSymbols("/a.ts", [{ symbol: "loneFunc", kind: "def", line: 1 }]);
		expect(store.getReferencesTo("loneFunc")).toEqual([]);
	});

	it("upserts zero symbols (clears a file)", () => {
		store.upsertSymbols("/src/foo.ts", [{ symbol: "x", kind: "def", line: 1 }]);
		store.upsertSymbols("/src/foo.ts", []);
		expect(store.getSymbolsForFile("/src/foo.ts")).toHaveLength(0);
	});

	it("null target_file and target_symbol on insert", () => {
		store.upsertSymbols("/a.ts", [{ symbol: "fn", kind: "def", line: 1 }]);
		const rows = store.getSymbolsForFile("/a.ts");
		expect(rows[0].target_file).toBeNull();
		expect(rows[0].target_symbol).toBeNull();
	});

	describe("resolveReferences", () => {
		it("resolves refs to defs in other files", () => {
			// File A defines 'sharedFn', File B references it
			store.upsertSymbols("/a.ts", [{ symbol: "sharedFn", kind: "def", line: 1 }]);
			store.upsertSymbols("/b.ts", [{ symbol: "sharedFn", kind: "ref", line: 5 }]);

			const resolved = store.resolveReferences();
			expect(resolved).toBe(1);

			const rows = store.getSymbolsForFile("/b.ts");
			const ref = rows.find((r) => r.kind === "ref");
			expect(ref?.target_file).toBe("/a.ts");
			expect(ref?.target_symbol).toBe("sharedFn");
		});

		it("does not resolve refs to defs in the same file", () => {
			// Same file has both def and ref - should not create cross-file edge
			store.upsertSymbols("/a.ts", [
				{ symbol: "localFn", kind: "def", line: 1 },
				{ symbol: "localFn", kind: "ref", line: 10 },
			]);

			const resolved = store.resolveReferences();
			expect(resolved).toBe(0);

			const rows = store.getSymbolsForFile("/a.ts");
			const ref = rows.find((r) => r.kind === "ref");
			expect(ref?.target_file).toBeNull();
		});

		it("resolves multiple refs across files", () => {
			store.upsertSymbols("/lib.ts", [{ symbol: "helper", kind: "def", line: 1 }]);
			store.upsertSymbols("/a.ts", [{ symbol: "helper", kind: "ref", line: 5 }]);
			store.upsertSymbols("/b.ts", [{ symbol: "helper", kind: "ref", line: 3 }]);

			const resolved = store.resolveReferences();
			expect(resolved).toBe(2);
		});

		it("handles symbol with no matching def", () => {
			store.upsertSymbols("/a.ts", [{ symbol: "unknownFn", kind: "ref", line: 5 }]);

			const resolved = store.resolveReferences();
			expect(resolved).toBe(0);

			const rows = store.getSymbolsForFile("/a.ts");
			expect(rows[0].target_file).toBeNull();
		});
	});
});
