/**
 * UX formatters for Veil context display.
 */

import { formatTokens } from "./utils.ts";

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
	return "=".repeat(filled) + ".".repeat(empty);
}

export function formatBox(content: string[], title?: string, width: number = 60): string[] {
	const innerWidth = width - 4;
	const lines: string[] = [];

	if (title) {
		const titlePart = `-- ${title} `;
		const remaining = width - 1 - titlePart.length;
		lines.push(`+${titlePart}${"-".repeat(Math.max(0, remaining))}+`);
	} else {
		lines.push(`+${"-".repeat(width - 2)}+`);
	}

	for (const line of content) {
		const padded = line.slice(0, innerWidth).padEnd(innerWidth);
		lines.push(`|  ${padded}|`);
	}

	lines.push(`+${"-".repeat(width - 2)}+`);
	return lines;
}

export function formatStatusBar(usedTokens: number, maxTokens: number): StatusBarResult {
	const percent = maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;
	const text = `Context: ${formatTokens(usedTokens)}/${formatTokens(maxTokens)}`;
	const color = getHealthColor(percent);
	return { text, color };
}
