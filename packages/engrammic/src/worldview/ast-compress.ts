/**
 * AST compression for context storage.
 *
 * Instead of storing full function bodies, we compress to:
 *   `signature [IMPL:hash]`
 *
 * where:
 *   - signature = function name + parameter list + return type (human-readable)
 *   - hash      = first 8 hex chars of SHA-256 of the implementation body
 *
 * Supported languages: TypeScript, JavaScript, Python, Go.
 *
 * This is groundwork for Phase 7 compression — actual integration with context
 * storage is handled by a separate layer.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SyntaxNode, Tree } from "./parser.ts";
import { TreeSitterParser, getLanguageForFile } from "./parser.ts";

// ---------------------------------------------------------------------------
// Language-specific node types for functions/methods
// ---------------------------------------------------------------------------

/**
 * Node types that represent callable units (functions, methods, closures) in
 * each supported language.
 */
const FUNCTION_NODE_TYPES: Record<string, Set<string>> = {
	typescript: new Set([
		"function_declaration",
		"function",
		"generator_function_declaration",
		"generator_function",
		"method_definition",
		"arrow_function",
	]),
	tsx: new Set([
		"function_declaration",
		"function",
		"generator_function_declaration",
		"generator_function",
		"method_definition",
		"arrow_function",
	]),
	javascript: new Set([
		"function_declaration",
		"function",
		"generator_function_declaration",
		"generator_function",
		"method_definition",
		"arrow_function",
	]),
	python: new Set([
		"function_definition",
		"async_function_definition",
	]),
	go: new Set([
		"function_declaration",
		"method_declaration",
	]),
};

/**
 * Node types that represent the implementation body of a function in each
 * supported language.
 */
const BODY_NODE_TYPES: Record<string, Set<string>> = {
	typescript: new Set(["statement_block"]),
	tsx: new Set(["statement_block"]),
	javascript: new Set(["statement_block"]),
	python: new Set(["block"]),
	go: new Set(["block"]),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the first 8 hex characters of the SHA-256 digest of `implText`.
 *
 * Used to detect implementation changes without storing the full body.
 *
 * @param implText - The raw text of the function body (including braces/colon).
 */
export function hashImplementation(implText: string): string {
	return createHash("sha256").update(implText, "utf8").digest("hex").slice(0, 8);
}

/**
 * Extract the human-readable signature of a function/method node.
 *
 * The signature is everything in the source up to (but not including) the
 * opening brace / colon of the body, trimmed of trailing whitespace.
 *
 * Returns `null` for node types that are not callable units in `langName`,
 * or when the node has no identifiable body.
 *
 * @param node     - A SyntaxNode from web-tree-sitter.
 * @param langName - Tree-sitter language name (e.g. "typescript", "python").
 */
export function extractSignature(node: SyntaxNode, langName: string): string | null {
	const fnTypes = FUNCTION_NODE_TYPES[langName];
	if (!fnTypes || !fnTypes.has(node.type)) return null;

	const bodyTypes = BODY_NODE_TYPES[langName] ?? new Set<string>();
	const bodyNode = findBodyNode(node, bodyTypes);

	if (bodyNode === null) {
		// No body found — might be an abstract/external declaration; return
		// the full node text as the "signature".
		return node.text.trim();
	}

	// Signature = everything in node.text before the body node's text begins.
	//
	// We locate the body by searching for its text content within the node's
	// text rather than using row/column arithmetic. This is more robust against
	// grammar variations where startPosition.column may not align exactly with
	// the character offset (e.g. when node text starts mid-line).
	const bodyIdx = node.text.indexOf(bodyNode.text);
	let sig: string;

	if (bodyIdx > 0) {
		sig = node.text.slice(0, bodyIdx);
	} else if (bodyIdx === 0) {
		// Body occupies the entire node — no signature prefix.
		return null;
	} else {
		// indexOf returned -1: body text not found inside node text.
		// Fall back to the full node text.
		sig = node.text;
	}

	return sig.trimEnd() || null;
}

/**
 * Compress a single function node to `signature [IMPL:hash]`.
 *
 * Returns `null` when:
 * - The node is not a function/method in `langName`.
 * - No implementation body can be identified.
 *
 * @param node     - A SyntaxNode from web-tree-sitter.
 * @param content  - The full source text of the file (used to extract body).
 * @param langName - Tree-sitter language name.
 */
export function compressFunction(
	node: SyntaxNode,
	content: string,
	langName: string,
): string | null {
	const sig = extractSignature(node, langName);
	if (sig === null) return null;

	const bodyTypes = BODY_NODE_TYPES[langName] ?? new Set<string>();
	const bodyNode = findBodyNode(node, bodyTypes);
	if (bodyNode === null) return null;

	// Extract body text directly from content using byte positions so we are
	// not confused by multi-line offsets.
	const bodyText = extractNodeText(bodyNode, content);
	const hash = hashImplementation(bodyText);

	return `${sig} [IMPL:${hash}]`;
}

/**
 * Compress all top-level (and class-level) functions in a file.
 *
 * Non-function lines are preserved verbatim. Each function node is replaced
 * with its compressed form. Nested functions inside function bodies are NOT
 * individually compressed — they are captured as part of the outer body hash.
 *
 * Returns the compressed file as a string. Returns the original `content`
 * unchanged when:
 * - The file extension is not recognized.
 * - The parser fails to parse the file.
 *
 * @param filePath - Absolute path used to infer the language.
 * @param content  - Source text of the file.
 * @param parser   - An already-initialized TreeSitterParser.
 */
export async function compressFile(
	filePath: string,
	content: string,
	parser: TreeSitterParser,
): Promise<string> {
	const langName = getLanguageForFile(filePath);
	if (langName === null) return content;

	const tree = await parser.parse(filePath, content);
	if (tree === null) return content;

	// Collect top-level function nodes (direct children of the root, plus
	// methods inside class bodies).
	const fnNodes = collectFunctionNodes(tree, langName);
	if (fnNodes.length === 0) return content;

	const lines = content.split("\n");

	// Build a sorted list of replacements: { startRow, endRow, replacement }
	// We process them from bottom to top to avoid row-number drift.
	interface Replacement {
		startRow: number;
		endRow: number;
		startCol: number;
		endCol: number;
		text: string;
	}

	const replacements: Replacement[] = [];

	for (const node of fnNodes) {
		const compressed = compressFunction(node, content, langName);
		if (compressed === null) continue;

		replacements.push({
			startRow: node.startPosition.row,
			endRow: node.endPosition.row,
			startCol: node.startPosition.column,
			endCol: node.endPosition.column,
			text: compressed,
		});
	}

	// Sort descending by startRow so we can splice from the bottom up without
	// invalidating earlier line numbers.
	replacements.sort((a, b) => b.startRow - a.startRow || b.startCol - a.startCol);

	// Apply replacements line-by-line. We rebuild the lines array.
	const resultLines = [...lines];

	for (const r of replacements) {
		const indent = " ".repeat(r.startCol);
		// Replace the range [startRow, endRow] (inclusive) with the compressed text.
		resultLines.splice(r.startRow, r.endRow - r.startRow + 1, `${indent}${r.text}`);
	}

	return resultLines.join("\n");
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Find the body (block/suite/statement_block) child of a function node.
 */
function findBodyNode(node: SyntaxNode, bodyTypes: Set<string>): SyntaxNode | null {
	// Python uses a "block" child named "body"; TS/JS use "statement_block".
	// Try childForFieldName("body") first, then fall back to type scan.
	const n = node as any;
	if (typeof n.childForFieldName === "function") {
		const body = n.childForFieldName("body");
		if (body && bodyTypes.has(body.type)) return body as SyntaxNode;
	}

	// Fallback: scan named children for a body-type node
	for (const child of node.namedChildren) {
		if (bodyTypes.has(child.type)) return child;
	}

	return null;
}

/**
 * Extract the raw text of a SyntaxNode from the full file content using
 * character-level row/column positions.
 *
 * This is more reliable than `node.text` in some edge cases where the parser
 * computes text lazily or includes surrounding whitespace.
 */
function extractNodeText(node: SyntaxNode, content: string): string {
	const lines = content.split("\n");
	const startRow = node.startPosition.row;
	const startCol = node.startPosition.column;
	const endRow = node.endPosition.row;
	const endCol = node.endPosition.column;

	if (startRow === endRow) {
		return (lines[startRow] ?? "").slice(startCol, endCol);
	}

	const parts: string[] = [];
	parts.push((lines[startRow] ?? "").slice(startCol));
	for (let r = startRow + 1; r < endRow; r++) {
		parts.push(lines[r] ?? "");
	}
	parts.push((lines[endRow] ?? "").slice(0, endCol));
	return parts.join("\n");
}

/**
 * Collect function/method nodes that should be individually compressed.
 *
 * Strategy:
 * - Walk the root's direct named children.
 * - For class bodies, also walk into class member lists.
 * - Do NOT recurse into function bodies (nested functions are captured by the
 *   outer hash).
 */
function collectFunctionNodes(tree: Tree, langName: string): SyntaxNode[] {
	const fnTypes = FUNCTION_NODE_TYPES[langName];
	if (!fnTypes) return [];

	const results: SyntaxNode[] = [];
	walkForFunctions(tree.rootNode, fnTypes, langName, results, false);
	return results;
}

function walkForFunctions(
	node: SyntaxNode,
	fnTypes: Set<string>,
	langName: string,
	results: SyntaxNode[],
	insideFunction: boolean,
): void {
	if (fnTypes.has(node.type)) {
		if (!insideFunction) {
			results.push(node);
		}
		// Do NOT recurse further — nested functions belong to the outer body hash.
		return;
	}

	// Node types that are transparent containers we should recurse through
	const isTransparent = isTransparentContainer(node.type, langName);

	if (isTransparent || !insideFunction) {
		for (const child of node.namedChildren) {
			walkForFunctions(child, fnTypes, langName, results, insideFunction);
		}
	}
}

/**
 * Returns true for node types that act as containers for top-level or
 * class-level definitions (program, module, class body, export statements…).
 */
function isTransparentContainer(nodeType: string, langName: string): boolean {
	switch (nodeType) {
		// Universal roots
		case "program":
		case "module":
		case "source_file":
		case "translation_unit":
			return true;

		// Class bodies contain methods
		case "class_body":
		case "class_declaration":
		case "abstract_class_declaration":
			return true;

		// Export wrappers in JS/TS
		case "export_statement":
		case "lexical_declaration":
		case "variable_declaration":
		case "variable_declarator":
			return langName === "typescript" || langName === "tsx" || langName === "javascript";

		// Go top-level declarations
		case "declaration":
			return langName === "go";

		default:
			return false;
	}
}
