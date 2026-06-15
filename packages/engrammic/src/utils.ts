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
	if (maxChars <= 0) return "";
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
 * Generate SHA-256 hash of full content for deduplication.
 */
export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Format token count for display.
 */
export function formatTokens(n: number): string {
	if (n >= 1000) {
		const val = n / 1000;
		return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}k`;
	}
	return `${n}`;
}

/**
 * Format a Unix millisecond timestamp as a human-readable relative time string.
 */
export function formatRelativeTime(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);

	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}hr ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}
