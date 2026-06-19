/**
 * Shared utilities for extractors.
 */

/**
 * Truncate a string to maxLen, adding ... if truncated.
 */
export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 3)}...`;
}

/**
 * Extract file extension from a path.
 */
export function extractExtension(filePath: string): string {
	const parts = filePath.split(".");
	if (parts.length < 2) return "";
	const ext = parts.pop()!.toLowerCase();
	return ext.length <= 6 ? ext : "";
}

/**
 * Truncate a command string, preserving the command name.
 */
export function truncateCmd(command: string, maxLen: number = 100): string {
	if (command.length <= maxLen) return command;
	// Keep command name and first few args
	const parts = command.split(/\s+/);
	let result = parts[0];
	for (let i = 1; i < parts.length && result.length < maxLen - 10; i++) {
		result += ` ${parts[i]}`;
	}
	return `${result} ...`;
}

/**
 * Check if an extension is a known code file.
 */
const CODE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"pyw",
	"rs",
	"go",
	"java",
	"kt",
	"kts",
	"c",
	"cpp",
	"cc",
	"cxx",
	"h",
	"hpp",
	"cs",
	"rb",
	"php",
	"swift",
	"scala",
	"clj",
	"cljs",
	"ex",
	"exs",
	"erl",
	"hrl",
	"lua",
	"r",
	"jl",
	"zig",
	"nim",
	"v",
	"d",
	"dart",
	"elm",
	"fs",
	"fsx",
	"ml",
	"mli",
	"hs",
	"lhs",
	"pl",
	"pm",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"sql",
	"vue",
	"svelte",
]);

export function isCodeExtension(ext: string): boolean {
	return CODE_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Extract domain from a URL.
 */
export function extractDomain(url: string): string {
	try {
		return new URL(url).hostname.replace("www.", "");
	} catch {
		return "unknown";
	}
}
