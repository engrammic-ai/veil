/**
 * Read tool extractor - captures file structure, not full content.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { extractExtension, isCodeExtension, truncate } from "./utils.ts";

/**
 * Fast regex-based structure extraction for code files.
 * NOTE: TreeSitterParser (worldview/parser.ts) cannot be used here — both
 * Parser.init() and Parser.parse() are async (WASM), but the Extractor type
 * is synchronous. To use tree-sitter, the Extractor type must be changed to
 * return Promise<ExtractorResult> and all call sites updated accordingly.
 */
function extractStructureFast(content: string, ext: string): string {
	const exports: string[] = [];
	const signatures: string[] = [];
	const lineCount = content.split("\n").length;

	if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
		// Captures: export const, export function, export class, etc.
		const exportRe =
			/^export\s+(default\s+)?(const|let|var|function|async function|class|interface|type|enum)\s+(\w+)?/gm;
		for (const m of content.matchAll(exportRe)) {
			const isDefault = m[1] ? "default " : "";
			const kind = m[2];
			const name = m[3] || "(anonymous)";
			exports.push(`export ${isDefault}${kind} ${name}`);
		}

		// Also capture non-exported top-level declarations
		const declRe = /^(const|let|var|function|async function|class|interface|type|enum)\s+(\w+)/gm;
		for (const m of content.matchAll(declRe)) {
			const decl = `${m[1]} ${m[2]}`;
			if (!exports.some((e) => e.includes(m[2]))) {
				signatures.push(decl);
			}
		}
	} else if (ext === "py") {
		const defRe = /^(def|class|async def)\s+(\w+)/gm;
		for (const m of content.matchAll(defRe)) {
			signatures.push(`${m[1]} ${m[2]}`);
		}
	} else if (ext === "go") {
		const funcRe = /^func\s+(\([^)]+\)\s+)?(\w+)/gm;
		for (const m of content.matchAll(funcRe)) {
			signatures.push(`func ${m[2]}`);
		}
		const typeRe = /^type\s+(\w+)\s+(struct|interface)/gm;
		for (const m of content.matchAll(typeRe)) {
			signatures.push(`type ${m[1]} ${m[2]}`);
		}
	} else if (ext === "rs") {
		const fnRe = /^(pub\s+)?(async\s+)?fn\s+(\w+)/gm;
		for (const m of content.matchAll(fnRe)) {
			const pub = m[1] ? "pub " : "";
			const async_ = m[2] ? "async " : "";
			signatures.push(`${pub}${async_}fn ${m[3]}`);
		}
		const structRe = /^(pub\s+)?(struct|enum|trait)\s+(\w+)/gm;
		for (const m of content.matchAll(structRe)) {
			const pub = m[1] ? "pub " : "";
			signatures.push(`${pub}${m[2]} ${m[3]}`);
		}
	}

	const items = [...new Set([...exports, ...signatures])];
	if (items.length > 0) {
		return `${items.slice(0, 20).join("\n")}\n(${lineCount} lines)`;
	}

	// Fallback for unknown code files
	return `(${lineCount} lines)`;
}

/**
 * Extract markdown structure (headers + code block languages).
 */
function extractMarkdownStructure(content: string): string {
	const lines = content.split("\n");
	const headers: string[] = [];
	const codeBlocks: string[] = [];

	for (const line of lines) {
		const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
		if (headerMatch) {
			const indent = "  ".repeat(headerMatch[1].length - 1);
			headers.push(`${indent}${headerMatch[2]}`);
		}
	}

	const codeBlockRe = /```(\w+)?/g;
	for (const m of content.matchAll(codeBlockRe)) {
		if (m[1]) codeBlocks.push(m[1]);
	}

	const outline = headers.length ? headers.slice(0, 10).join("\n") : "";
	const langs = codeBlocks.length ? `Code: ${[...new Set(codeBlocks)].join(", ")}` : "";

	return [outline, langs].filter(Boolean).join("\n") || `(${lines.length} lines)`;
}

/**
 * Extract JSON/YAML structure (top-level keys).
 */
function extractStructuredData(content: string, ext: string): string {
	const keys: string[] = [];
	const lineCount = content.split("\n").length;

	if (ext === "json") {
		const keyRe = /^\s*"(\w+)":/gm;
		for (const m of content.matchAll(keyRe)) {
			if (keys.length < 20) keys.push(m[1]);
		}
	} else if (ext === "yaml" || ext === "yml") {
		const keyRe = /^(\w[\w-]*):/gm;
		for (const m of content.matchAll(keyRe)) {
			if (keys.length < 20) keys.push(m[1]);
		}
	}

	if (keys.length > 0) {
		return `Keys: ${keys.join(", ")}\n(${lineCount} lines)`;
	}
	return `(${lineCount} lines)`;
}

export const readExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { file_path } = ctx.args;

	if (typeof file_path !== "string") {
		return { text: "", skipCapture: true };
	}

	const ext = extractExtension(file_path);
	let structure: string;

	if (isCodeExtension(ext)) {
		structure = extractStructureFast(ctx.content, ext);
	} else if (["md", "markdown"].includes(ext)) {
		structure = extractMarkdownStructure(ctx.content);
	} else if (["json", "yaml", "yml"].includes(ext)) {
		structure = extractStructuredData(ctx.content, ext);
	} else {
		// Plain text - just line count and preview
		const lines = ctx.content.split("\n");
		const preview = lines.slice(0, 3).join("\n");
		structure = `${truncate(preview, 150)}\n(${lines.length} lines)`;
	}

	return {
		text: `[Read] ${file_path}\n${structure}`,
		extraTags: ext ? [`ext:${ext}`] : [],
	};
};
