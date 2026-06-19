// packages/engrammic/src/injection.ts

import type { AttemptRecord } from "./attempts.ts";
import type { ContextItem } from "./types.ts";
import { estimateTokens } from "./utils.ts";

const TYPE_MAP: Record<ContextItem["type"], string> = {
	episodic: "EPISODE",
	fact: "FACT",
	procedural: "PROC",
	decision: "DECISION",
};

export function formatStub(item: ContextItem): string {
	const prefix = TYPE_MAP[item.type];
	const summary = item.content.slice(0, 50).replace(/\n/g, " ").trim();
	return `[${prefix}:${item.id}:${summary}]`;
}

export interface ContextSectionItem {
	item: ContextItem;
	score: number;
}

export interface ContextSectionOptions {
	items: ContextSectionItem[];
	budget: { usedTokens: number; maxTokens: number };
}

export function buildContextSection(options: ContextSectionOptions): string {
	const { items } = options;

	if (items.length === 0) {
		return "<veil-context>\nNo items loaded. Use recall(tags) to find context.\n</veil-context>";
	}

	const totalTokens = items.reduce((sum, { item }) => sum + estimateTokens(item.content), 0);
	const lines: string[] = [];

	lines.push("<veil-context>");
	lines.push(
		`Loaded context (${items.length} ${items.length === 1 ? "item" : "items"}, ${formatTokens(totalTokens)}):`,
	);

	for (const { item, score } of items) {
		const stub = formatStub(item);
		const tokens = estimateTokens(item.content);
		const pinned = item.pinned ? ", pinned" : "";
		lines.push(`- ${stub} (score: ${score.toFixed(2)}, ${formatTokens(tokens)}${pinned})`);
	}

	lines.push("");
	lines.push('Use veil_hydrate({stub: "[EPISODE:id]"}) to expand. Use veil_recall({tags: [...]}) to find more.');
	lines.push("</veil-context>");

	return lines.join("\n");
}

function formatTokens(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k tokens`;
	}
	return `${n} tokens`;
}

// ─── D.2 — Failure Surfacing ──────────────────────────────────────────────────

/**
 * Format turn age in human-readable form.
 */
export function formatTurnAge(turns: number): string {
	if (turns === 0) return "this turn";
	if (turns === 1) return "1 turn ago";
	return `${turns} turns ago`;
}

export interface FailureSectionOptions {
	attempts: AttemptRecord[];
	currentTurn: number;
	maxAttempts?: number;
}

/**
 * Build the <veil-failures> block for injection into context.
 * Shows recent failed/uncertain attempts for the current goal.
 */
export function buildFailureSection(options: FailureSectionOptions): string {
	const { attempts, currentTurn, maxAttempts = 5 } = options;

	if (attempts.length === 0) return "";

	const recent = attempts.filter((a) => a.outcome === "fail" || a.outcome === "uncertain").slice(-maxAttempts);

	if (recent.length === 0) return "";

	const goalId = recent[0].goalId;
	const lines = [`<veil-failures goal="${goalId}">`];
	lines.push(`Already tried (${recent.length} ${recent.length === 1 ? "attempt" : "attempts"}):\n`);

	for (let i = 0; i < recent.length; i++) {
		const a = recent[i];
		const age = formatTurnAge(currentTurn - a.turn);
		lines.push(`${i + 1}. [${age}] ${a.action}: ${a.target ?? "(no target)"}`);
		if (a.evidence) {
			lines.push(`   FAILED: ${a.evidence.slice(0, 100)}`);
		}
	}

	const patterns = recent.map((a) => a.errorPattern).filter(Boolean) as string[];
	const patternCounts = countOccurrences(patterns);
	const repeated = Object.entries(patternCounts).find(([, count]) => count >= 2);
	if (repeated) {
		lines.push(`\nPattern: ${repeated[0].slice(0, 60)} (${repeated[1]} occurrences)`);
	}

	lines.push("</veil-failures>");
	return lines.join("\n");
}

function countOccurrences(items: string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) {
		counts[item] = (counts[item] ?? 0) + 1;
	}
	return counts;
}
