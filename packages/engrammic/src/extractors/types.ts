/**
 * Extractor types for smart memory capture.
 * Extractors transform raw tool output into compact, high-value captures.
 */

import type { ContextCache } from "../cache.ts";

export interface ExtractorContext {
	toolName: string;
	args: Record<string, unknown>;
	content: string; // raw text from tool result
	isError: boolean;
	exitCode?: number; // Bash-specific
	cache?: ContextCache; // warm cache reference for fire-and-forget upgrades
	dedupeKey?: string; // resolved dedupeKey for the item about to be stored
}

export interface ExtractorResult {
	text: string; // compressed/extracted content
	extraTags?: string[]; // extractor-discovered tags (e.g., "error:ENOENT")
	cognitiveWeight?: number; // -1 to +1, success/failure attribution
	skipCapture?: boolean; // extractor says "don't store this"
}

export type Extractor = (ctx: ExtractorContext) => ExtractorResult;

/**
 * Enhanced CaptureRule with extractor selection.
 */
export interface EnhancedCaptureRule {
	type: "episodic" | "fact" | "decision";
	tags: string[];
	extractor: string; // name of extractor to use
	maxTokens: number;
	priority: "high" | "normal" | "low";
	dedupeKey?: string; // key for deduplication
	debounceWindowMs?: number; // merge rapid calls within this window
}
