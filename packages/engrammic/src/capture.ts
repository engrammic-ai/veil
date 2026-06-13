/**
 * Capture logic for auto-storing tool results into episodic/fact memory.
 */

import type { CaptureRule } from "./types.ts";

/**
 * Returns a CaptureRule (type + tags) if the given tool call should be captured,
 * or null if it should be skipped.
 */
export function getCaptureRule(toolName: string, args: unknown): CaptureRule | null {
	switch (toolName) {
		case "Read":
			return { type: "episodic", tags: ["file", "read"] };

		case "WebSearch":
			return { type: "fact", tags: ["web", "search"] };

		case "WebFetch":
			return { type: "fact", tags: ["web", "fetch"] };

		case "Bash": {
			const command = (args as Record<string, unknown> | undefined)?.command ?? "";
			return classifyBashCommand(String(command));
		}

		default:
			return null;
	}
}

/**
 * Classify a bash command string and return the appropriate CaptureRule, or null
 * if the command is not in the capture list.
 *
 * Handles pipes by checking each segment independently.
 */
function classifyBashCommand(command: string): CaptureRule | null {
	// Strip common prefixes (sudo, time, env VAR=val) before pattern matching
	const clean = (cmd: string): string =>
		cmd.replace(/^(sudo|time|env\s+\S+=\S+)\s+/g, "").trim();

	const checkSegment = (segment: string): CaptureRule | null => {
		const c = clean(segment);
		if (/^(grep|rg|ag|ack)\b/.test(c)) return { type: "episodic", tags: ["search", "grep"] };
		if (/^find\b/.test(c)) return { type: "episodic", tags: ["search", "find"] };
		if (/^git\s+diff\b/.test(c)) return { type: "episodic", tags: ["git", "diff"] };
		if (/^git\s+(log|show)\b/.test(c)) return { type: "episodic", tags: ["git", "history"] };
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
	if (/^src\//.test(filepath)) tags.push("source");
	if (/^docs?\//.test(filepath)) tags.push("docs");

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
