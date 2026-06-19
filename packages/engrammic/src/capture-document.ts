/**
 * OKF-style CaptureDocument normalization layer.
 * Converts all captures to a structured intermediate format before storage.
 */

import type { EnhancedCaptureRule, ExtractorResult } from "./extractors/types.ts";

export type CaptureType =
	| "edit"
	| "error"
	| "read"
	| "write"
	| "search"
	| "subagent"
	| "mcp"
	| "skill"
	| "deps"
	| "bash";

export interface CaptureLink {
	rel: "caused_by" | "fixes" | "supersedes" | "related" | "file" | "error";
	target: string; // Memory ID or file path
	label?: string;
}

export interface CaptureDocument {
	type: CaptureType;
	title: string;
	timestamp: string; // ISO 8601
	resource?: string; // File path, URL, or command
	tags: string[];
	outcome?: "success" | "failure" | "partial";
	exitCode?: number;
	duration?: number; // milliseconds
	links: CaptureLink[];
	body: string;
}

// Maps tool names to CaptureType
const TOOL_TYPE_MAP: Record<string, CaptureType> = {
	edit: "edit",
	write: "write",
	read: "read",
	bash: "bash",
	agent: "subagent",
	skill: "skill",
	websearch: "search",
	webfetch: "read",
};

function mapToolToType(toolName: string): CaptureType {
	const normalized = toolName.toLowerCase();
	if (normalized.startsWith("mcp__")) return "mcp";
	// deps bash commands
	if (normalized === "bash") return "bash";
	return TOOL_TYPE_MAP[normalized] ?? "bash";
}

function extractResource(toolName: string, args: unknown): string | undefined {
	const argObj = args as Record<string, unknown> | undefined;
	if (!argObj) return undefined;

	const normalized = toolName.toLowerCase();

	if (normalized === "edit" || normalized === "read" || normalized === "write") {
		const fp = argObj.file_path as string | undefined;
		if (!fp) return undefined;
		// For edit, include line range if present
		const startLine = argObj.start_line as number | undefined;
		const endLine = argObj.end_line as number | undefined;
		if (startLine !== undefined && endLine !== undefined) {
			return `${fp}:${startLine}-${endLine}`;
		}
		return fp;
	}

	if (normalized === "bash") {
		const cmd = argObj.command as string | undefined;
		return cmd ? (cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd) : undefined;
	}

	if (normalized === "websearch" || normalized === "webfetch") {
		return (argObj.query ?? argObj.url) as string | undefined;
	}

	if (normalized.startsWith("mcp__")) {
		// Use server name from tool name: mcp__server__tool -> server
		const parts = normalized.split("__");
		return parts[1] ?? undefined;
	}

	return undefined;
}

function generateTitle(toolName: string, args: unknown, extracted: ExtractorResult): string {
	const argObj = args as Record<string, unknown> | undefined;
	const normalized = toolName.toLowerCase();

	// Use first non-empty line of extracted text as title if it's short enough
	const firstLine = extracted.text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);

	if (firstLine && firstLine.length <= 80 && !firstLine.startsWith("---")) {
		// Strip markdown frontmatter markers and diff syntax
		const cleaned = firstLine.replace(/^[+-]{3}\s*/, "").trim();
		if (cleaned.length > 0 && cleaned.length <= 80) {
			return cleaned;
		}
	}

	// Generate from tool + resource
	const resource = extractResource(toolName, args);
	const basename = resource ? (resource.split("/").pop() ?? resource) : undefined;

	if (normalized === "edit") return basename ? `Edit ${basename}` : "Edit file";
	if (normalized === "write") return basename ? `Write ${basename}` : "Write file";
	if (normalized === "read") return basename ? `Read ${basename}` : "Read file";
	if (normalized === "bash") {
		const cmd = argObj?.command as string | undefined;
		if (cmd) {
			const short = cmd.trim().split(/\s+/).slice(0, 4).join(" ");
			return `Run: ${short.length > 50 ? `${short.slice(0, 47)}...` : short}`;
		}
		return "Bash command";
	}
	if (normalized === "websearch") return `Search: ${argObj?.query ?? "web"}`;
	if (normalized === "webfetch") return `Fetch: ${basename ?? "URL"}`;
	if (normalized === "agent") {
		const desc = argObj?.description as string | undefined;
		return desc ? `Subagent: ${desc.slice(0, 60)}` : "Subagent";
	}
	if (normalized === "skill") return `Skill: ${argObj?.skill ?? "unknown"}`;
	if (normalized.startsWith("mcp__")) {
		const parts = normalized.split("__");
		return `MCP: ${parts[1] ?? toolName}/${parts[2] ?? ""}`;
	}

	return toolName;
}

// Detect success/failure from content patterns and exitCode
function detectOutcome(text: string, exitCode?: number): "success" | "failure" | "partial" | undefined {
	if (exitCode !== undefined) {
		return exitCode === 0 ? "success" : "failure";
	}

	// Pattern-based detection
	if (/\[OK\]|\bsuccess(fully)?\b|all tests passed|0 errors/i.test(text)) return "success";
	if (/\[FAIL\]|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|TypeError|SyntaxError/i.test(text))
		return "failure";

	return undefined;
}

// Extract file paths from text (simple heuristic)
const FILE_PATH_RE =
	/(?:^|\s)((?:\/[^\s/]+)+(?:\.[a-zA-Z0-9]{1,6})?|(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9]{1,6})?)/gm;

function extractFilePaths(text: string): string[] {
	const paths = new Set<string>();
	FILE_PATH_RE.lastIndex = 0;
	for (let m = FILE_PATH_RE.exec(text); m !== null; m = FILE_PATH_RE.exec(text)) {
		const p = m[1].trim();
		if (p.length > 3 && p.includes("/")) {
			paths.add(p);
		}
	}
	return [...paths].slice(0, 10);
}

/**
 * Normalize a tool capture into a structured CaptureDocument.
 */
export function normalizeCapture(
	toolName: string,
	args: unknown,
	extracted: ExtractorResult,
	rule: EnhancedCaptureRule,
	timestamp?: number,
): CaptureDocument {
	const argObj = args as Record<string, unknown> | undefined;
	const normalized = toolName.toLowerCase();

	const type = mapToolToType(normalized);
	// For bash, refine type based on rule tags
	const finalType: CaptureType = type === "bash" && rule.tags.includes("deps") ? "deps" : type;

	const resource = extractResource(toolName, args);
	const exitCode = argObj?.exitCode as number | undefined;
	const outcome = detectOutcome(extracted.text, exitCode);

	const links: CaptureLink[] = [];

	// Auto-link to the primary resource file
	if (resource && (finalType === "edit" || finalType === "write" || finalType === "read")) {
		const cleanResource = resource.replace(/:\d+-\d+$/, ""); // strip line range
		links.push({ rel: "file", target: cleanResource });
	}

	// Auto-link to file paths mentioned in extracted text
	if (extracted.text) {
		const filePaths = extractFilePaths(extracted.text);
		for (const fp of filePaths) {
			// Don't duplicate the primary resource
			const cleanResource = resource?.replace(/:\d+-\d+$/, "");
			if (fp !== cleanResource) {
				links.push({ rel: "file", target: fp });
			}
		}
	}

	// For args with explicit file_path, also link that
	if (argObj?.file_path && typeof argObj.file_path === "string") {
		const alreadyLinked = links.some((l) => l.target === argObj.file_path);
		if (!alreadyLinked) {
			links.push({ rel: "file", target: argObj.file_path as string });
		}
	}

	const tags = [...rule.tags, ...(extracted.extraTags ?? [])];

	return {
		type: finalType,
		title: generateTitle(toolName, args, extracted),
		timestamp: new Date(timestamp ?? Date.now()).toISOString(),
		resource,
		tags,
		outcome,
		exitCode,
		links,
		body: extracted.text,
	};
}
