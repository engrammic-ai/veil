/**
 * UX formatters for Veil context display.
 */

import type { EvictionCandidate, EvictionNotifyConfig } from "./types.ts";
import { estimateTokens, formatTokens } from "./utils.ts";

export type HealthColor = "success" | "warning" | "accent" | "error";

export interface StatusBarResult {
	text: string;
	color: HealthColor;
}

export function getHealthColor(percent: number): HealthColor {
	if (percent < 50) return "success";
	if (percent < 70) return "warning";
	if (percent < 85) return "accent";
	return "error";
}

export function formatProgressBar(percent: number, width: number): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	return "█".repeat(filled) + "░".repeat(empty);
}

export function formatBox(content: string[], title?: string, width: number = 60): string[] {
	const innerWidth = width - 4;
	const lines: string[] = [];

	if (title) {
		const titlePart = `─ ${title} `;
		const remaining = width - 1 - titlePart.length;
		lines.push(`╭${titlePart}${"─".repeat(Math.max(0, remaining))}╮`);
	} else {
		lines.push(`╭${"─".repeat(width - 2)}╮`);
	}

	for (const line of content) {
		const padded = line.slice(0, innerWidth).padEnd(innerWidth);
		lines.push(`│  ${padded}│`);
	}

	lines.push(`╰${"─".repeat(width - 2)}╯`);
	return lines;
}

export function formatStatusBar(usedTokens: number, maxTokens: number, reserveTokens: number = 0): StatusBarResult {
	const available = maxTokens - reserveTokens;
	const percent = available > 0 ? (usedTokens / available) * 100 : 0;
	const text = `Context: ${formatTokens(usedTokens)}/${formatTokens(available)}`;
	const color = getHealthColor(percent);
	return { text, color };
}

export function formatEvictionNotification(evicted: EvictionCandidate[], config: EvictionNotifyConfig): string | null {
	if (!config.enabled) return null;
	if (evicted.length < config.minItems) return null;

	const count = evicted.length;

	if (config.verbosity === "minimal") {
		return `Evicted ${count} items`;
	}

	const summaries = evicted
		.slice(0, 3)
		.map((e) => e.item.content.slice(0, 20).replace(/\n/g, " ").trim())
		.join(", ");

	if (config.verbosity === "standard") {
		return `Evicted ${count} items (${summaries}${count > 3 ? ", ..." : ""})`;
	}

	const freedTokens = evicted.reduce((sum, e) => sum + estimateTokens(e.item.content), 0);
	return `Evicted ${count} items to free ${formatTokens(freedTokens)} tokens: ${summaries}${count > 3 ? ", ..." : ""}`;
}
