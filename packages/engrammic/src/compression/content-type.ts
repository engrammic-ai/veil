/**
 * Content-type detection for compression routing.
 *
 * Deterministic heuristics to classify chunks as code, prose, config, or conversation.
 * Used by the compression dispatcher to select the appropriate compressor.
 */

export type ContentType = "code" | "prose" | "config" | "conversation";

export interface ContentMetadata {
	filePath?: string;
	toolName?: string;
	tags?: string[];
}

const CODE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"scala",
	"c",
	"cpp",
	"cc",
	"h",
	"hpp",
	"cs",
	"rb",
	"php",
	"swift",
	"m",
	"mm",
	"lua",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"psm1",
	"pl",
	"pm",
	"r",
	"R",
	"jl",
	"ex",
	"exs",
	"erl",
	"hrl",
	"hs",
	"lhs",
	"ml",
	"mli",
	"fs",
	"fsi",
	"fsx",
	"clj",
	"cljs",
	"cljc",
	"edn",
	"elm",
	"v",
	"sv",
	"vhd",
	"vhdl",
	"zig",
	"nim",
	"cr",
	"d",
	"pas",
	"pp",
	"asm",
	"s",
	"S",
	"wasm",
	"wat",
	"sol",
	"vy",
	"move",
]);

const CONFIG_EXTENSIONS = new Set([
	"json",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"config",
	"env",
	"properties",
	"xml",
	"plist",
	"lock",
]);

const PROSE_EXTENSIONS = new Set(["md", "mdx", "rst", "txt", "adoc", "asciidoc", "org", "tex", "html", "htm"]);

const CODE_PATTERNS = [
	/^(import|export|from|require)\s/m,
	/^(function|class|interface|type|enum|const|let|var|def|fn|pub|async|await)\s/m,
	/^(if|else|for|while|switch|case|return|throw|try|catch|finally)\s/m,
	/[{};]\s*$/m,
	/^\s*(public|private|protected|static|readonly)\s/m,
	/^#include\s/m,
	/^package\s+\w/m,
	/^using\s+\w/m,
];

const JSON_PATTERN = /^\s*[[{]/;
const YAML_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*:\s/m;

const CONVERSATION_PATTERNS = [
	/^(Human|Assistant|User|AI|System|Claude|GPT):\s/im,
	/^>\s+.+$/m,
	/^\[[\d:]+\]\s/m,
	/<(message|turn|response|query)>/i,
];

const DETECTION_SAMPLE_SIZE = 2000;

/**
 * Detect content type from text and metadata.
 *
 * Priority:
 * 1. File extension (most reliable when available)
 * 2. Structural patterns (JSON/YAML detection)
 * 3. Content heuristics (code patterns, conversation markers)
 * 4. Default to prose
 */
export function detectContentType(text: string, metadata?: ContentMetadata): ContentType {
	const ext = extractExtension(metadata?.filePath);

	if (ext) {
		if (CODE_EXTENSIONS.has(ext)) return "code";
		if (CONFIG_EXTENSIONS.has(ext)) return "config";
		if (PROSE_EXTENSIONS.has(ext)) return "prose";
	}

	if (metadata?.tags?.includes("conversation")) return "conversation";

	const trimmed = text.slice(0, DETECTION_SAMPLE_SIZE);

	// Check conversation BEFORE YAML since both use "key:" pattern
	for (const pattern of CONVERSATION_PATTERNS) {
		if (pattern.test(trimmed)) return "conversation";
	}

	if (JSON_PATTERN.test(trimmed)) {
		try {
			JSON.parse(text);
			return "config";
		} catch {
			// JSON.parse failed — don't assume config, let other heuristics decide
		}
	}

	if (YAML_PATTERN.test(trimmed) && !CODE_PATTERNS.some((p) => p.test(trimmed))) {
		return "config";
	}

	let codeScore = 0;
	for (const pattern of CODE_PATTERNS) {
		if (pattern.test(trimmed)) codeScore++;
	}
	if (codeScore >= 2) return "code";

	return "prose";
}

function extractExtension(filePath?: string): string | null {
	if (!filePath) return null;
	const parts = filePath.split(".");
	if (parts.length < 2) return null;
	return parts.pop()?.toLowerCase() ?? null;
}
