/**
 * Compression dispatcher — routes chunks to the appropriate compressor by content type.
 *
 * Two-speed rule:
 * - Deterministic compressors (code, config, conversation) run on the hot path
 * - Model-based compressors (prose) are slow-path only, gated by config
 *
 * Non-destructive: compressed output is a view; original is always recoverable.
 */

import type { TreeSitterParser } from "../worldview/parser.ts";
import { type CodeCompressOptions, compressCode } from "./code-compress.ts";
import { type ConfigCompressOptions, compressConfig } from "./config-compress.ts";
import { type ContentMetadata, type ContentType, detectContentType } from "./content-type.ts";
import { type ConversationCompressOptions, compressConversation } from "./conversation-compress.ts";

export interface CompressionResult {
	compressed: string;
	contentType: ContentType;
	ratio: number;
	method: "ast" | "key-extract" | "head-tail" | "none";
}

export interface CompressOptions {
	metadata?: ContentMetadata;
	code?: CodeCompressOptions;
	config?: ConfigCompressOptions;
	conversation?: ConversationCompressOptions;
	parser?: TreeSitterParser;
	minSavingsRatio?: number;
}

const DEFAULT_MIN_SAVINGS = 0.2;

/**
 * Compress a chunk using the appropriate strategy for its content type.
 *
 * Returns the original text unchanged if:
 * - Content type doesn't have a compressor
 * - Compression doesn't achieve minSavingsRatio
 * - Compression fails for any reason
 */
export async function compress(text: string, options: CompressOptions = {}): Promise<CompressionResult> {
	if (text.length === 0) {
		return { compressed: text, contentType: "prose", ratio: 1, method: "none" };
	}

	const contentType = detectContentType(text, options.metadata);
	const minSavings = options.minSavingsRatio ?? DEFAULT_MIN_SAVINGS;

	let compressed: string;
	let method: CompressionResult["method"];

	switch (contentType) {
		case "code":
			compressed = await compressCode(text, options.metadata?.filePath, options.parser, options.code);
			method = "ast";
			break;

		case "config":
			compressed = compressConfig(text, options.config);
			method = "key-extract";
			break;

		case "conversation":
			compressed = compressConversation(text, options.conversation);
			method = "head-tail";
			break;
		default:
			return { compressed: text, contentType, ratio: 1, method: "none" };
	}

	const ratio = compressed.length / text.length;

	if (ratio > 1 - minSavings) {
		return { compressed: text, contentType, ratio: 1, method: "none" };
	}

	return { compressed, contentType, ratio, method };
}

/**
 * Synchronous compression for content types that don't need async (config, conversation).
 * Falls back to original for code (needs parser) and prose.
 */
export function compressSync(text: string, options: CompressOptions = {}): CompressionResult {
	if (text.length === 0) {
		return { compressed: text, contentType: "prose", ratio: 1, method: "none" };
	}

	const contentType = detectContentType(text, options.metadata);
	const minSavings = options.minSavingsRatio ?? DEFAULT_MIN_SAVINGS;

	let compressed: string;
	let method: CompressionResult["method"];

	switch (contentType) {
		case "config":
			compressed = compressConfig(text, options.config);
			method = "key-extract";
			break;

		case "conversation":
			compressed = compressConversation(text, options.conversation);
			method = "head-tail";
			break;
		default:
			return { compressed: text, contentType, ratio: 1, method: "none" };
	}

	const ratio = compressed.length / text.length;

	if (ratio > 1 - minSavings) {
		return { compressed: text, contentType, ratio: 1, method: "none" };
	}

	return { compressed, contentType, ratio, method };
}
