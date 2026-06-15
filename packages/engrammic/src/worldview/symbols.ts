/**
 * Symbol extraction from parsed source files using tree-sitter query patterns.
 *
 * Ports Aider's .scm query approach (MIT-licensed patterns) to extract:
 *   - Definitions (functions, classes, methods, interfaces, type aliases, etc.)
 *   - References (identifier usages against known definition names)
 *
 * Supported languages: TypeScript, JavaScript, Python, Go.
 *
 * The extractor walks the AST via depth-first traversal and matches node types
 * to language-specific definition patterns without requiring the full
 * tree-sitter query API (which needs additional WASM query objects).
 */

import type { SyntaxNode, Tree } from "./parser.ts";
import { TreeSitterParser } from "./parser.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SymbolKind = "def" | "ref";

export interface ExtractedSymbol {
	symbol: string;
	kind: SymbolKind;
	/** 1-based line number of the symbol in the file */
	line: number;
}

// ---------------------------------------------------------------------------
// Language-specific definition node types
//
// These mirror the patterns in Aider's tree-sitter .scm files for each
// language, mapped to web-tree-sitter node type strings.
//
// Each entry: [parentNodeType, nameFieldOrChildType]
// ---------------------------------------------------------------------------

interface DefPattern {
	/** tree-sitter node type for the definition container */
	nodeType: string;
	/** name of the named child that holds the identifier, or null if text of the node itself */
	nameField: string | null;
}

const DEF_PATTERNS: Record<string, DefPattern[]> = {
	typescript: [
		{ nodeType: "function_declaration", nameField: "name" },
		{ nodeType: "function", nameField: "name" },
		{ nodeType: "generator_function_declaration", nameField: "name" },
		{ nodeType: "arrow_function", nameField: null }, // anonymous — skip unless assigned
		{ nodeType: "class_declaration", nameField: "name" },
		{ nodeType: "class", nameField: "name" },
		{ nodeType: "method_definition", nameField: "name" },
		{ nodeType: "interface_declaration", nameField: "name" },
		{ nodeType: "type_alias_declaration", nameField: "name" },
		{ nodeType: "enum_declaration", nameField: "name" },
		{ nodeType: "abstract_class_declaration", nameField: "name" },
	],
	tsx: [
		{ nodeType: "function_declaration", nameField: "name" },
		{ nodeType: "function", nameField: "name" },
		{ nodeType: "generator_function_declaration", nameField: "name" },
		{ nodeType: "class_declaration", nameField: "name" },
		{ nodeType: "class", nameField: "name" },
		{ nodeType: "method_definition", nameField: "name" },
		{ nodeType: "interface_declaration", nameField: "name" },
		{ nodeType: "type_alias_declaration", nameField: "name" },
		{ nodeType: "enum_declaration", nameField: "name" },
		{ nodeType: "abstract_class_declaration", nameField: "name" },
	],
	javascript: [
		{ nodeType: "function_declaration", nameField: "name" },
		{ nodeType: "function", nameField: "name" },
		{ nodeType: "generator_function_declaration", nameField: "name" },
		{ nodeType: "class_declaration", nameField: "name" },
		{ nodeType: "class", nameField: "name" },
		{ nodeType: "method_definition", nameField: "name" },
	],
	python: [
		{ nodeType: "function_definition", nameField: "name" },
		{ nodeType: "decorated_definition", nameField: null }, // walk into child
		{ nodeType: "class_definition", nameField: "name" },
		{ nodeType: "async_function_definition", nameField: "name" },
	],
	go: [
		{ nodeType: "function_declaration", nameField: "name" },
		{ nodeType: "method_declaration", nameField: "name" },
		{ nodeType: "type_declaration", nameField: null }, // contains type_spec children
		{ nodeType: "type_spec", nameField: "name" },
		{ nodeType: "short_var_declaration", nameField: null }, // walk left
	],
};

// For variable assignments that capture function/class expressions
// (e.g. `const Foo = function() {}` or `export const bar = () => {}`)
const ASSIGNMENT_DEF_RHS_TYPES = new Set([
	"function",
	"function_declaration",
	"arrow_function",
	"class",
	"generator_function",
]);

// ---------------------------------------------------------------------------
// AST walker
// ---------------------------------------------------------------------------

/**
 * Walk the AST depth-first and collect definition nodes.
 * Returns {symbol, line} for each definition found.
 */
function walkDefs(
	node: SyntaxNode,
	patterns: DefPattern[],
	language: string,
	results: Array<{ symbol: string; line: number }>,
): void {
	const nodeType = node.type;
	const line = node.startPosition.row + 1; // 1-based

	// Check if this node is a definition container
	const pattern = patterns.find((p) => p.nodeType === nodeType);
	if (pattern) {
		if (pattern.nameField !== null) {
			// Find named child by field name
			const nameNode = getFieldChild(node, pattern.nameField);
			if (nameNode && nameNode.text.trim()) {
				results.push({ symbol: nameNode.text.trim(), line });
			}
		} else if (nodeType === "decorated_definition" && language === "python") {
			// Python decorated_definition: drill into the actual definition child
			for (const child of node.namedChildren) {
				if (
					child.type === "function_definition" ||
					child.type === "class_definition" ||
					child.type === "async_function_definition"
				) {
					const nameNode = getFieldChild(child, "name");
					if (nameNode && nameNode.text.trim()) {
						results.push({ symbol: nameNode.text.trim(), line: child.startPosition.row + 1 });
					}
				}
			}
		} else if (nodeType === "type_declaration" && language === "go") {
			// Go type_declaration contains type_spec children
			for (const child of node.namedChildren) {
				if (child.type === "type_spec") {
					const nameNode = getFieldChild(child, "name");
					if (nameNode && nameNode.text.trim()) {
						results.push({ symbol: nameNode.text.trim(), line: child.startPosition.row + 1 });
					}
				}
			}
		}
		// For arrow_function and short_var_declaration without nameField,
		// fall through to check for assignment patterns below
	}

	// Variable/const/let assignment: `const Foo = function(){}` or `const bar = () => {}`
	if (nodeType === "lexical_declaration" || nodeType === "variable_declaration" || nodeType === "export_statement") {
		extractAssignmentDefs(node, results, language);
	}

	// Recurse into children
	for (const child of node.namedChildren) {
		walkDefs(child, patterns, language, results);
	}
}

/**
 * For `const Foo = <function-like>` patterns, extract `Foo` as a def.
 */
function extractAssignmentDefs(
	node: SyntaxNode,
	results: Array<{ symbol: string; line: number }>,
	_language: string,
): void {
	// Walk named children looking for variable_declarator nodes
	for (const child of node.namedChildren) {
		if (child.type === "variable_declarator") {
			const nameNode = getFieldChild(child, "name");
			const valueNode = getFieldChild(child, "value");
			if (nameNode && valueNode && ASSIGNMENT_DEF_RHS_TYPES.has(valueNode.type)) {
				results.push({
					symbol: nameNode.text.trim(),
					line: nameNode.startPosition.row + 1,
				});
			}
		}
		// export statement wraps declaration — recurse one level
		if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
			extractAssignmentDefs(child, results, _language);
		}
	}
}

/**
 * Walk the AST and collect identifier references that match known def names.
 * We restrict to identifiers that appear as call expressions or member access
 * to keep the reference set manageable.
 */
function walkRefs(node: SyntaxNode, knownDefs: Set<string>, results: Array<{ symbol: string; line: number }>): void {
	const nodeType = node.type;
	const line = node.startPosition.row + 1;

	// Call expressions: foo() or foo.bar() - capture the function name
	if (nodeType === "call_expression") {
		const funcNode = getFieldChild(node, "function");
		if (funcNode) {
			const name = extractCallName(funcNode);
			if (name && knownDefs.has(name)) {
				results.push({ symbol: name, line });
			}
		}
	}

	// Identifier nodes that match known defs (outside of definitions themselves)
	if (nodeType === "identifier" || nodeType === "type_identifier") {
		const name = node.text.trim();
		if (name && knownDefs.has(name)) {
			results.push({ symbol: name, line });
		}
	}

	for (const child of node.namedChildren) {
		walkRefs(child, knownDefs, results);
	}
}

/**
 * Extract the base function name from a call expression's function node.
 * Handles: `foo`, `obj.foo`, `obj?.foo`.
 */
function extractCallName(node: SyntaxNode): string | null {
	if (node.type === "identifier") return node.text.trim();
	if (node.type === "member_expression" || node.type === "subscript_expression") {
		// obj.method — grab the property (last part)
		const prop = getFieldChild(node, "property");
		if (prop) return prop.text.trim();
	}
	return null;
}

// ---------------------------------------------------------------------------
// Field child lookup
// ---------------------------------------------------------------------------

/**
 * tree-sitter named children don't always surface as fields via the JS API
 * without the full query object. This heuristic matches children by their
 * position relative to named-child types — good enough for symbol extraction.
 *
 * Web-tree-sitter's JS API exposes `node.childForFieldName(name)` but only
 * when the grammar is loaded with full field metadata. Since we load grammars
 * from WASM at runtime and the field metadata is embedded in the grammar, we
 * rely on a type-based heuristic as fallback.
 */
function getFieldChild(node: SyntaxNode, fieldName: string): SyntaxNode | null {
	// Try the proper API first (available in web-tree-sitter)
	const n = node as any;
	if (typeof n.childForFieldName === "function") {
		return n.childForFieldName(fieldName) ?? null;
	}

	// Heuristic fallback: match by type name
	const FIELD_TO_TYPE: Record<string, string[]> = {
		name: ["identifier", "type_identifier", "property_identifier", "field_identifier"],
		function: ["identifier", "member_expression", "subscript_expression"],
		value: ["function", "arrow_function", "class", "generator_function", "function_declaration"],
		property: ["property_identifier", "identifier"],
	};

	const acceptedTypes = FIELD_TO_TYPE[fieldName];
	if (!acceptedTypes) return null;

	for (const child of node.namedChildren) {
		if (acceptedTypes.includes(child.type)) return child;
	}
	return null;
}

// ---------------------------------------------------------------------------
// SymbolExtractor
// ---------------------------------------------------------------------------

export class SymbolExtractor {
	private readonly parser: TreeSitterParser;

	constructor(parser?: TreeSitterParser) {
		this.parser = parser ?? new TreeSitterParser();
	}

	async init(): Promise<void> {
		await this.parser.init();
	}

	/**
	 * Extract symbols (defs and refs) from source content.
	 *
	 * Returns an array of ExtractedSymbol. The caller is responsible for
	 * deduplicating if needed (the store handles that via PRIMARY KEY).
	 */
	async extractSymbols(filePath: string, content: string): Promise<ExtractedSymbol[]> {
		const tree = await this.parser.parse(filePath, content);
		if (tree === null) return [];

		const language = tree.language.name;
		return extractFromTree(tree, language);
	}
}

/**
 * Extract symbols from a pre-parsed tree. Exported for testing.
 */
export function extractFromTree(tree: Tree, language: string): ExtractedSymbol[] {
	const patterns = DEF_PATTERNS[language] ?? [];

	const defs: Array<{ symbol: string; line: number }> = [];
	walkDefs(tree.rootNode, patterns, language, defs);

	// Deduplicate defs (same symbol + line may appear via multiple patterns)
	const deduped = new Map<string, { symbol: string; line: number }>();
	for (const d of defs) {
		const key = `${d.symbol}:${d.line}`;
		if (!deduped.has(key)) deduped.set(key, d);
	}
	const uniqueDefs = Array.from(deduped.values());

	// Build set of known def names for ref matching
	const knownNames = new Set(uniqueDefs.map((d) => d.symbol));

	// Extract refs (only for symbols we found defs for)
	const refRaw: Array<{ symbol: string; line: number }> = [];
	if (knownNames.size > 0) {
		walkRefs(tree.rootNode, knownNames, refRaw);
	}

	// Deduplicate refs (same symbol + line)
	const dedupedrefs = new Map<string, { symbol: string; line: number }>();
	for (const r of refRaw) {
		const key = `${r.symbol}:${r.line}`;
		if (!dedupedrefs.has(key)) dedupedrefs.set(key, r);
	}

	// Build result: defs first, then refs (excluding lines that are defs)
	const defLines = new Set(uniqueDefs.map((d) => `${d.symbol}:${d.line}`));

	const result: ExtractedSymbol[] = [
		...uniqueDefs.map((d) => ({ symbol: d.symbol, kind: "def" as SymbolKind, line: d.line })),
		...Array.from(dedupedrefs.values())
			.filter((r) => !defLines.has(`${r.symbol}:${r.line}`))
			.map((r) => ({ symbol: r.symbol, kind: "ref" as SymbolKind, line: r.line })),
	];

	return result;
}
