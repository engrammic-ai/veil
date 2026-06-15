/**
 * Tree-sitter based source file parser for the behavioral worldview.
 *
 * Supports lazy grammar loading: the WASM for each language is loaded once on
 * first use and cached. Unknown extensions and grammar load failures are
 * handled gracefully (return null rather than throwing).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// web-tree-sitter type declarations (the @types package has issues with WASM exports)
export interface SyntaxNode {
	type: string;
	text: string;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	children: SyntaxNode[];
	namedChildren: SyntaxNode[];
	parent: SyntaxNode | null;
}

export interface Tree {
	rootNode: SyntaxNode;
	language: Language;
}

interface Language {
	name: string;
}

interface ParserInstance {
	setLanguage(language: Language): void;
	parse(input: string): Tree;
}

interface ParserStatic {
	init(): Promise<void>;
	Language: {
		load(path: string): Promise<Language>;
	};
	new (): ParserInstance;
}

// Dynamic import to work around WASM module typing issues
let Parser: ParserStatic | null = null;

async function getParser(): Promise<ParserStatic> {
	if (Parser === null) {
		const mod = await import("web-tree-sitter");
		Parser = mod.default as unknown as ParserStatic;
	}
	return Parser;
}

// ---------------------------------------------------------------------------
// Extension map
// ---------------------------------------------------------------------------

/**
 * Maps file extensions (without leading dot) to tree-sitter language names.
 * Language names correspond to the npm package `tree-sitter-{lang}` and the
 * wasm file `tree-sitter-{lang}.wasm` contained within.
 */
export const EXTENSION_MAP: Record<string, string> = {
	c: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	h: "cpp",
	hpp: "cpp",
	cs: "c_sharp",
	css: "css",
	el: "elisp",
	ex: "elixir",
	exs: "elixir",
	elm: "elm",
	go: "go",
	html: "html",
	htm: "html",
	java: "java",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	kt: "kotlin",
	kts: "kotlin",
	lua: "lua",
	m: "objc",
	ml: "ocaml",
	mli: "ocaml",
	php: "php",
	py: "python",
	ql: "ql",
	rb: "ruby",
	rs: "rust",
	scala: "scala",
	sc: "scala",
	sol: "solidity",
	swift: "swift",
	ts: "typescript",
	tsx: "tsx",
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns the tree-sitter language name for the given file path, or null if
 * the extension is not recognized.
 */
export function getLanguageForFile(filePath: string): string | null {
	const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
	return EXTENSION_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TreeSitterParserOptions {
	/**
	 * Override the directory in which grammar `.wasm` files are searched.
	 * Defaults to `<package-root>/node_modules`.
	 */
	grammarDir?: string;
}

// ---------------------------------------------------------------------------
// TreeSitterParser
// ---------------------------------------------------------------------------

/**
 * Wraps `web-tree-sitter` with lazy grammar loading and graceful error
 * handling. Call `init()` once before calling `parse()`.
 */
export class TreeSitterParser {
	private initialized = false;
	private readonly languageCache = new Map<string, Language>();
	private readonly grammarDir: string;

	constructor(options: TreeSitterParserOptions = {}) {
		if (options.grammarDir !== undefined) {
			this.grammarDir = options.grammarDir;
		} else {
			// Resolve relative to this file's location:
			// packages/engrammic/src/worldview/parser.ts  →  packages/engrammic/node_modules
			const __filename = fileURLToPath(import.meta.url);
			const __dirname = path.dirname(__filename);
			this.grammarDir = path.join(__dirname, "..", "..", "node_modules");
		}
	}

	/**
	 * Initialize the WASM runtime. Must be called before `parse()`.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;
		const P = await getParser();
		await P.init();
		this.initialized = true;
	}

	/**
	 * Parse the given source `content` as the language inferred from
	 * `filePath`'s extension.
	 *
	 * Returns `null` when:
	 * - The file extension is not recognized.
	 * - The grammar `.wasm` file cannot be loaded.
	 */
	async parse(filePath: string, content: string): Promise<Tree | null> {
		if (!this.initialized) {
			throw new Error("TreeSitterParser.init() must be called before parse()");
		}

		const lang = getLanguageForFile(filePath);
		if (lang === null) return null;

		const language = await this.loadLanguage(lang);
		if (language === null) return null;

		const P = await getParser();
		const parser = new P();
		parser.setLanguage(language);
		return parser.parse(content);
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private async loadLanguage(lang: string): Promise<Language | null> {
		const cached = this.languageCache.get(lang);
		if (cached !== undefined) return cached;

		const wasmPath = path.join(this.grammarDir, `tree-sitter-${lang}`, `tree-sitter-${lang}.wasm`);

		try {
			const P = await getParser();
			const language = await P.Language.load(wasmPath);
			this.languageCache.set(lang, language);
			return language;
		} catch (err) {
			console.warn(
				`[TreeSitterParser] Failed to load grammar for "${lang}" from ${wasmPath}:`,
				err instanceof Error ? err.message : String(err),
			);
			return null;
		}
	}
}
