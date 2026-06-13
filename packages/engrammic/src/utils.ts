import { createHash } from "node:crypto";

/**
 * Estimate token count using ~4 chars per token heuristic.
 * Fast approximation, no API call required.
 */
export function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * Truncate content while preserving head and tail context.
 * Keeps first 70% and last 25% of maxChars, with an ellipsis marker in the middle.
 */
export function smartTruncate(content: string, maxChars: number): string {
	if (content.length <= maxChars) {
		return content;
	}

	const headSize = Math.floor(maxChars * 0.7);
	const tailSize = Math.floor(maxChars * 0.25);
	const truncated = content.length - headSize - tailSize;

	const head = content.slice(0, headSize);
	const tail = content.slice(content.length - tailSize);

	return `${head}\n\n... [${truncated} chars truncated] ...\n\n${tail}`;
}

/**
 * Generate a fast content hash using the first 1000 chars + content length.
 * Returns first 16 chars of SHA-256 hex digest for deduplication.
 */
export function contentHash(content: string): string {
	const sample = content.slice(0, 1000) + content.length;
	return createHash("sha256").update(sample).digest("hex").slice(0, 16);
}
