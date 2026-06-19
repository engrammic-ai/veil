/**
 * MCP tool extractor - captures MCP tool invocations with key identifiers.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { truncate } from "./utils.ts";

export const mcpExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { toolName, args } = ctx;

	if (!toolName) {
		return { text: "", skipCapture: true };
	}

	const keyArgs = extractKeyMcpArgs(toolName, args ?? {});
	const outcome = ctx.isError ? "FAILED" : "OK";

	return {
		text: `[MCP ${toolName}] ${outcome}\n${keyArgs}`,
		extraTags: ["mcp", `mcp:${toolName.split("__")[1] || toolName}`],
		cognitiveWeight: ctx.isError ? -0.3 : 0.1,
	};
};

function extractKeyMcpArgs(toolName: string, args: Record<string, unknown>): string {
	if (!args || typeof args !== "object") {
		return "";
	}

	// GitHub: PR/issue numbers
	if (toolName.includes("github")) {
		const pr = args.pull_number || args.pr || args.number;
		const repo = args.repo || args.repository;
		if (pr) return `PR #${pr}${repo ? ` in ${repo}` : ""}`;
	}

	// Notion: page IDs/titles
	if (toolName.includes("notion")) {
		const val = args.page_id || args.title;
		if (val) return String(val);
		return truncate(JSON.stringify(args), 100);
	}

	// Slack: channel/message
	if (toolName.includes("slack")) {
		const val = args.channel || args.conversation;
		return val ? String(val) : "message";
	}

	// Generic: first string arg
	const firstStr = Object.values(args).find((v) => typeof v === "string");
	return truncate(String(firstStr ?? JSON.stringify(args)), 100);
}
