/**
 * Edit tool extractor - captures file edits with truncated diff.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";
import { extractExtension, truncate } from "./utils.ts";

export const editExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { file_path, old_string, new_string, replace_all } = ctx.args;

	if (typeof file_path !== "string") {
		return { text: "", skipCapture: true };
	}

	const oldSnip = truncate(String(old_string ?? ""), 200);
	const newSnip = truncate(String(new_string ?? ""), 200);
	const ext = extractExtension(file_path);
	const replaceNote = replace_all ? " (replace_all)" : "";

	const text = `[Edit] ${file_path}${replaceNote}
-${oldSnip}
+${newSnip}`;

	return {
		text,
		extraTags: ext ? [`ext:${ext}`] : [],
		cognitiveWeight: 0.2, // edits are generally positive progress
	};
};
