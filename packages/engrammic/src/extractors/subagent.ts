/**
 * Subagent extractor - captures agent dispatch outcomes with duration.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { truncate } from "./utils.ts";

export const subagentExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { prompt, description, agentType, durationMs } = ctx.args;

	// Agent tool uses 'description', fallback to 'prompt' for compatibility
	const taskText = (typeof description === "string" && description) || (typeof prompt === "string" && prompt);
	if (!taskText) {
		return { text: "", skipCapture: true };
	}

	const promptSnip = truncate(taskText, 50);
	const outcome = ctx.isError ? "FAILED" : "OK";
	const duration = durationMs ? ` (${Math.round((durationMs as number) / 1000)}s)` : "";
	const type = typeof agentType === "string" && agentType ? agentType : "default";

	return {
		text: `[Agent ${type}] ${outcome}${duration}: ${promptSnip}`,
		extraTags: ["subagent", ...(typeof agentType === "string" && agentType ? [agentType] : [])],
		cognitiveWeight: ctx.isError ? -0.4 : 0.1,
	};
};
