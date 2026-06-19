/**
 * Read tool extractor - captures file structure, not full content.
 */

import type { ContextCache } from "../cache.ts";
import { TreeSitterParser } from "../worldview/parser.ts";
import { extractFromTree } from "../worldview/symbols.ts";
import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { extractExtension, isCodeExtension, truncate } from "./utils.ts";

// Module-level singleton — kicks off WASM loading at import time
let parserReady: Promise<TreeSitterParser> | null = null;

function getParserInstance(): Promise<TreeSitterParser> {
	if (!parserReady) {
		const p = new TreeSitterParser();
		parserReady = p.init().then(() => p);
		parserReady.catch(() => {
			parserReady = null;
		});
	}
	return parserReady;
}
// Eagerly start loading WASM at module import
getParserInstance().catch(() => {});

async function upgradeWithTreeSitter(
	filePath: string,
	content: string,
	dedupeKey: string,
	cache: ContextCache,
): Promise<void> {
	const deadline = Date.now() + 50;
	try {
		const parser = await Promise.race([
			getParserInstance(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 50)),
		]);
		if (Date.now() > deadline) return;

		const tree = await parser.parse(filePath, content);
		if (!tree || Date.now() > deadline) return;

		const symbols = extractFromTree(tree, tree.language.name);
		const defs = symbols.filter((s) => s.kind === "def");
		if (defs.length === 0) return;

		const lines = content.split("\n").length;
		const structure = defs
			.slice(0, 20)
			.map((d) => d.symbol)
			.join("\n");
		const upgraded = `[Read] ${filePath}\n${structure}\n(${lines} lines)`;

		cache.updateByDedupeKey(dedupeKey, upgraded);
	} catch {
		// Silently fail — regex result stands
	}
}

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
	} else if (ext === "toml") {
		const sectionRe = /^\[(\w+)\]/gm;
		const keyRe = /^(\w+)\s*=/gm;
		for (const m of content.matchAll(sectionRe)) {
			if (keys.length < 20) keys.push(`[${m[1]}]`);
		}
		for (const m of content.matchAll(keyRe)) {
			if (keys.length < 20) keys.push(m[1]);
		}
	} else if (ext === "ini") {
		const sectionRe = /^\[(\w+)\]/gm;
		const keyRe = /^(\w+)\s*=/gm;
		for (const m of content.matchAll(sectionRe)) {
			if (keys.length < 20) keys.push(`[${m[1]}]`);
		}
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
	} else if (["json", "yaml", "yml", "toml", "ini"].includes(ext)) {
		structure = extractStructuredData(ctx.content, ext);
	} else {
		// Plain text - just line count and preview
		const lines = ctx.content.split("\n");
		const preview = lines.slice(0, 3).join("\n");
		structure = `${truncate(preview, 150)}\n(${lines.length} lines)`;
	}

	const result: ExtractorResult = {
		text: `[Read] ${file_path}\n${structure}`,
		extraTags: ext ? [`ext:${ext}`] : [],
	};

	// Fire-and-forget TreeSitter upgrade for code files when cache context is available
	if (isCodeExtension(ext) && ctx.cache && ctx.dedupeKey) {
		upgradeWithTreeSitter(file_path, ctx.content, ctx.dedupeKey, ctx.cache).catch(() => {});
	}

	return result;
};
