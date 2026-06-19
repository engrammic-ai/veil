/**
 * Skill tool extractor - captures skill invocations with outcome and args.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { truncate } from "./utils.ts";

export const skillExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { skill, args } = ctx.args;

	if (typeof skill !== "string" || !skill) {
		return { text: "", skipCapture: true };
	}

	const outcome = ctx.isError ? "FAILED" : "OK";
	const argsSnip = args ? `: ${truncate(String(args), 50)}` : "";

	return {
		text: `[Skill /${skill}] ${outcome}${argsSnip}`,
		extraTags: ["skill", `skill:${skill}`],
		cognitiveWeight: ctx.isError ? -0.2 : 0.1,
	};
};
