/**
 * Write tool extractor - captures new file writes with content preview.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { extractExtension, truncate } from "./utils.ts";

export const writeExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { file_path, content } = ctx.args;

	if (typeof file_path !== "string") {
		return { text: "", skipCapture: true };
	}

	if (typeof content !== "string") {
		return { text: "", skipCapture: true };
	}

	const lines = content.split("\n");
	const preview = lines.slice(0, 10).join("\n");
	const totalLines = lines.length;
	const ext = extractExtension(file_path);

	return {
		text: `[Write] ${file_path} (${totalLines} lines)\n${truncate(preview, 300)}`,
		extraTags: ext ? [`ext:${ext}`] : [],
		cognitiveWeight: 0.3,
	};
};
