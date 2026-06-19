/**
 * Bash command extractor - captures failures and key commands.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { truncate, truncateCmd } from "./utils.ts";

const ERROR_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
	{ pattern: /command not found/i, tag: "error:cmd-not-found" },
	{ pattern: /permission denied/i, tag: "error:permission" },
	{ pattern: /No such file or directory/i, tag: "error:ENOENT" },
	{ pattern: /npm ERR!/i, tag: "error:npm" },
	{ pattern: /SyntaxError|TypeError|ReferenceError/i, tag: "error:js-runtime" },
	{ pattern: /ENOENT|EACCES|EEXIST|EISDIR|ENOTDIR/i, tag: "error:fs" },
	{ pattern: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i, tag: "error:network" },
	{ pattern: /fatal:/i, tag: "error:git" },
	{ pattern: /ModuleNotFoundError|ImportError/i, tag: "error:python" },
	{ pattern: /error\[E\d+\]/i, tag: "error:rust" },
];

function classifyError(content: string): string | undefined {
	for (const { pattern, tag } of ERROR_PATTERNS) {
		if (pattern.test(content)) return tag;
	}
	return undefined;
}

function shouldCaptureSuccess(command: string): boolean {
	// Capture successful commands that have lasting effects
	const significantPatterns = [
		/^npm\s+(install|add|remove|uninstall|i|un)\b/,
		/^yarn\s+(add|remove|install)\b/,
		/^pnpm\s+(add|remove|install)\b/,
		/^pip\s+install\b/,
		/^cargo\s+(add|install)\b/,
		/^git\s+(commit|push|pull|merge|rebase|checkout|branch|stash)\b/,
		/^docker\s+(build|run|push|pull)\b/,
		/^make\b/,
		/^npm\s+run\s+build\b/,
	];
	return significantPatterns.some((p) => p.test(command));
}

function extractStderr(content: string): string {
	// Try to extract stderr-like content (error lines)
	const lines = content.split("\n");
	const errorLines = lines.filter(
		(line) =>
			/^error|^Error|^ERR!|^fatal:|^\s*at\s+/i.test(line) ||
			ERROR_PATTERNS.some(({ pattern }) => pattern.test(line)),
	);

	if (errorLines.length > 0) {
		return errorLines.slice(0, 10).join("\n");
	}

	// Fall back to last N lines
	return lines.slice(-20).join("\n");
}

export const bashExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { command } = ctx.args;
	const cmdStr = String(command ?? "");
	const exitCode = ctx.exitCode ?? (ctx.isError ? 1 : 0);

	// Skip low-value successful commands
	if (exitCode === 0 && !shouldCaptureSuccess(cmdStr)) {
		return { text: "", skipCapture: true };
	}

	const truncatedCmd = truncateCmd(cmdStr);

	if (exitCode === 0) {
		return {
			text: `[Bash OK] ${truncatedCmd}`,
			extraTags: [],
			cognitiveWeight: 0.1,
		};
	}

	// Failure case - extract relevant error info
	const stderr = extractStderr(ctx.content);
	const errorTag = classifyError(stderr);

	return {
		text: `[Bash FAIL exit=${exitCode}] ${truncatedCmd}
${truncate(stderr, 500)}`,
		// "failure" is an extension beyond spec §4.4 — useful for broad failure queries
		extraTags: errorTag ? [errorTag, "failure"] : ["failure"],
		cognitiveWeight: -0.5, // failures are negative but valuable to remember
	};
};
