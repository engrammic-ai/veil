/**
 * Capture logic for auto-storing tool results into episodic/fact memory.
 */

import type { EnhancedCaptureRule } from "./extractors/types.ts";

/**
 * Returns an EnhancedCaptureRule if the given tool call should be captured,
 * or null if it should be skipped.
 */
export function getCaptureRule(toolName: string, args: unknown): EnhancedCaptureRule | null {
	// Normalize tool name to handle case variations
	const normalized = toolName.toLowerCase();

	if (normalized.startsWith("mcp__")) {
		return {
			type: "fact",
			tags: ["mcp", normalized],
			extractor: "mcp",
			maxTokens: 200,
			priority: "normal",
		};
	}

	switch (normalized) {
		case "read":
			return {
				type: "episodic",
				tags: ["file", "read"],
				extractor: "read",
				maxTokens: 300,
				priority: "normal",
			};

		case "edit":
			return {
				type: "episodic",
				tags: ["file", "edit"],
				extractor: "edit",
				maxTokens: 200,
				priority: "high",
				dedupeKey: "edit",
				debounceWindowMs: 30000,
			};

		case "write":
			return {
				type: "episodic",
				tags: ["file", "write"],
				extractor: "write",
				maxTokens: 200,
				priority: "normal",
			};

		case "websearch":
		case "web_search":
			return {
				type: "fact",
				tags: ["web", "search"],
				extractor: "passthrough",
				maxTokens: 300,
				priority: "normal",
			};

		case "webfetch":
		case "web_fetch":
			return {
				type: "fact",
				tags: ["web", "fetch"],
				extractor: "passthrough",
				maxTokens: 300,
				priority: "normal",
			};

		case "bash": {
			const command = (args as Record<string, unknown> | undefined)?.command ?? "";
			return classifyBashCommand(String(command));
		}

		case "agent":
			return {
				type: "episodic",
				tags: ["agent"],
				extractor: "agent",
				maxTokens: 200,
				priority: "normal",
			};

		case "skill":
			return {
				type: "episodic",
				tags: ["skill"],
				extractor: "skill",
				maxTokens: 100,
				priority: "normal",
			};

		default:
			return null;
	}
}

/**
 * Classify a bash command string and return the appropriate EnhancedCaptureRule,
 * or null if the command is not in the capture list.
 *
 * Handles pipes by checking each segment independently.
 */
function classifyBashCommand(command: string): EnhancedCaptureRule | null {
	// Strip common prefixes (sudo, time, env VAR=val) before pattern matching
	// Use a while loop to handle stacked prefixes like `sudo time grep foo`
	const prefixPattern = /^(sudo|time|env\s+\S+=\S+)\s+/;
	const clean = (cmd: string): string => {
		let result = cmd.trim();
		while (prefixPattern.test(result)) {
			result = result.replace(prefixPattern, "").trim();
		}
		return result;
	};

	const checkSegment = (segment: string): EnhancedCaptureRule | null => {
		const c = clean(segment);
		if (/^(grep|rg|ag|ack)\b/.test(c))
			return { type: "episodic", tags: ["search", "grep"], extractor: "bash", maxTokens: 500, priority: "high" };
		if (/^find\b/.test(c))
			return { type: "episodic", tags: ["search", "find"], extractor: "bash", maxTokens: 500, priority: "high" };
		if (/^git\s+diff\b/.test(c))
			return { type: "episodic", tags: ["git", "diff"], extractor: "bash", maxTokens: 500, priority: "high" };
		if (/^git\s+(log|show)\b/.test(c))
			return { type: "episodic", tags: ["git", "history"], extractor: "bash", maxTokens: 500, priority: "high" };
		if (/^(npm\s+test|npx\s+vitest|npx\s+jest|vitest|jest|pytest)\b/.test(c))
			return { type: "episodic", tags: ["test", "bash"], extractor: "bash", maxTokens: 500, priority: "high" };
		if (/^(npm\s+(install|add)|yarn\s+add|pip\s+install)\b/.test(c))
			return { type: "episodic", tags: ["deps", "bash"], extractor: "deps", maxTokens: 500, priority: "normal" };
		return null;
	};

	// Try the full command first
	const direct = checkSegment(command);
	if (direct) return direct;

	// For piped commands, check each segment
	const segments = command.split(/\s*\|\s*/);
	for (const segment of segments) {
		const rule = checkSegment(segment);
		if (rule) return rule;
	}

	return null;
}

/**
 * Generate internal tags for a captured item based on tool name and args.
 * These are supplementary to the CaptureRule tags (not a replacement).
 */
export function generateInternalTags(toolName: string, args: unknown): string[] {
	const tags: string[] = [toolName.toLowerCase()];

	// Extract filepath if present
	const argObj = args as Record<string, unknown> | undefined;
	const filepath = argObj?.file_path as string | undefined;

	if (!filepath) return tags;

	// Directory path (first two path segments)
	const segments = filepath.split("/").filter(Boolean);
	if (segments.length >= 2) {
		tags.push(`dir:${segments.slice(0, 2).join("/")}`);
	}

	// File extension (up to 4 chars)
	const ext = filepath.split(".").pop();
	if (ext && ext.length <= 4) tags.push(`ext:${ext}`);

	// Special markers
	if (/test|spec|__test__|__spec__|\.test\.|\.spec\./i.test(filepath)) {
		tags.push("test");
	}
	if (filepath.includes("/src/") || filepath.startsWith("src/")) tags.push("source");
	if (/\/docs?\//i.test(filepath) || /^docs?\//i.test(filepath)) tags.push("docs");

	return tags;
}

/**
 * Extract plain text from a tool result content array (TextContent / ImageContent mix).
 * Only text blocks are included; image blocks are skipped.
 */
export function extractContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text as string)
		.join("\n");
}
