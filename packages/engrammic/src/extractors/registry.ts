/**
 * Extractor registry - maps tool names to extractor implementations.
 */

import { bashExtractor } from "./bash.ts";
import { depsExtractor } from "./deps.ts";
import { editExtractor } from "./edit.ts";
import { mcpExtractor } from "./mcp.ts";
import { readExtractor } from "./read.ts";
import { skillExtractor } from "./skill.ts";
import { subagentExtractor } from "./subagent.ts";
import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { truncate } from "./utils.ts";
import { writeExtractor } from "./write.ts";

/**
 * Passthrough extractor for unknown tools - just truncates content.
 */
const passthroughExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { toolName } = ctx;
	const truncated = truncate(ctx.content, 500);
	return {
		text: `[${toolName}] ${truncated}`,
		extraTags: ctx.isError ? ["failure"] : [],
		cognitiveWeight: ctx.isError ? -0.3 : 0,
	};
};

/**
 * Registry of extractors by tool name.
 * Falls back to passthrough for unknown tools.
 */
const EXTRACTORS: Record<string, Extractor> = {
	edit: editExtractor,
	write: writeExtractor,
	bash: bashExtractor,
	read: readExtractor,
	agent: subagentExtractor,
	skill: skillExtractor,
	mcp: mcpExtractor,
	deps: depsExtractor,
};

/**
 * Get an extractor by name, returning passthrough for unknown tools.
 */
export function getExtractor(name: string): Extractor {
	return EXTRACTORS[name] ?? passthroughExtractor;
}
