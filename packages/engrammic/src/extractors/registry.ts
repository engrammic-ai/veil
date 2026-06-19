/**
 * Extractor registry - maps tool names to extractor implementations.
 */

import { bashExtractor } from "./bash.ts";
import { editExtractor } from "./edit.ts";
import { readExtractor } from "./read.ts";
import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { truncate } from "./utils.ts";

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
	bash: bashExtractor,
	read: readExtractor,
};

/**
 * Get an extractor by name, returning passthrough for unknown tools.
 */
export function getExtractor(name: string): Extractor {
	return EXTRACTORS[name] ?? passthroughExtractor;
}
