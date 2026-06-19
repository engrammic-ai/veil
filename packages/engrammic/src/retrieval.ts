/**
 * Turn-start context selection.
 * Scores all cache items and greedily packs them into a token budget.
 */

import type { ContextCache } from "./cache.ts";
import { defaultFSRS } from "./fsrs.ts";
import type { ContextItem } from "./types.ts";
import { estimateTokens } from "./utils.ts";

export interface TurnContext {
	hasError: boolean;
	isEditing: boolean;
	currentFile?: string;
	recentFiles: string[];
	tags: string[];
}

export interface SelectionResult {
	items: ContextItem[];
	totalTokens: number;
}

/**
 * Compute relevance score for a single item given the current turn context.
 * Based on spec section 3.3.
 */
export function computeRelevanceScore(item: ContextItem, context: TurnContext): number {
	const now = Date.now();
	const daysSinceAccess = defaultFSRS.daysSince(item.lastAccess, now);
	let score = defaultFSRS.computeRetrievability(item.stability, daysSinceAccess);

	// Recency boost: exponential decay over 24h (spec uses hoursSince / 3600000)
	const hoursSince = (now - item.lastAccess) / 3_600_000;
	score *= 1 + 0.3 * Math.exp(-hoursSince / 24);

	// Frequency boost: log scale, capped at 0.5
	score *= 1 + Math.min(Math.log2(item.accessCount + 1) / 5, 0.5);

	// Type-specific boosts using tags (ContextItem has no 'failure'/'edit' type,
	// those semantics are carried by tags)
	const tagSet = new Set(item.tags);
	if (tagSet.has("failure") && context.hasError) score *= 1.8;
	if (tagSet.has("edit") && context.isEditing) score *= 1.4;

	// Success correlation boost: cognitiveWeight is -1..+1, same role as successCorrelation
	score *= 1 + item.cognitiveWeight * 0.5;

	// Ignored penalty: cognitiveWeight < 0 means net negative signal (ignored more than used)
	if (item.cognitiveWeight < 0) score *= 0.7;

	return Math.max(0, score);
}

/**
 * Select the most relevant items from cache that fit within the token budget.
 * Deduplicates by ID, sorts by score descending, then greedily packs.
 */
export function selectForTurn(cache: ContextCache, context: TurnContext, budget: number): SelectionResult {
	const all = cache.getAll();

	// Score and deduplicate (getAll should already return unique IDs, but be safe)
	const seen = new Map<string, { item: ContextItem; score: number }>();
	for (const item of all) {
		const score = computeRelevanceScore(item, context);
		const existing = seen.get(item.id);
		if (!existing || score > existing.score) {
			seen.set(item.id, { item, score });
		}
	}

	// Sort by score descending
	const ranked = [...seen.values()].sort((a, b) => b.score - a.score);

	// Greedy pack into budget
	const selected: ContextItem[] = [];
	let totalTokens = 0;
	for (const { item } of ranked) {
		const tokens = estimateTokens(item.content);
		if (totalTokens + tokens <= budget) {
			selected.push(item);
			totalTokens += tokens;
		}
	}

	return { items: selected, totalTokens };
}

/**
 * Format selected context items grouped by type as markdown sections.
 * Based on spec section 3.5.
 */
export function formatSelectedContext(items: ContextItem[]): string {
	if (items.length === 0) return "";

	const groups = new Map<string, ContextItem[]>();
	for (const item of items) {
		const key = item.type;
		const group = groups.get(key);
		if (group) {
			group.push(item);
		} else {
			groups.set(key, [item]);
		}
	}

	const sections: string[] = [];

	// Order: episodic → procedural → fact → decision
	const order: Array<ContextItem["type"]> = ["episodic", "procedural", "fact", "decision"];
	for (const type of order) {
		const group = groups.get(type);
		if (!group || group.length === 0) continue;

		const heading = typeHeading(type);
		const lines = group.map((item) => {
			const age = relativeAge(item.lastAccess);
			const snippet = item.content.slice(0, 120).replace(/\n/g, " ");
			const file = item.tags.find((t) => t.includes("/") || t.includes("."));
			return file ? `- [${file}] ${age}: ${snippet}` : `- ${age}: ${snippet}`;
		});

		sections.push(`## ${heading}\n${lines.join("\n")}`);
	}

	return sections.join("\n\n");
}

function typeHeading(type: ContextItem["type"]): string {
	switch (type) {
		case "episodic":
			return "Recent Episodes";
		case "procedural":
			return "Procedures";
		case "fact":
			return "Facts";
		case "decision":
			return "Decisions";
	}
}

function relativeAge(ts: number): string {
	const diff = Date.now() - ts;
	const m = Math.floor(diff / 60_000);
	if (m < 60) return `${m}min ago`;
	const h = Math.floor(diff / 3_600_000);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
