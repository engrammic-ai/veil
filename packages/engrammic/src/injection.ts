// packages/engrammic/src/injection.ts

import type { ContextItem } from "./types.ts";
import { estimateTokens } from "./utils.ts";

const TYPE_MAP: Record<ContextItem["type"], string> = {
	episodic: "EPISODE",
	fact: "FACT",
	procedural: "PROC",
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
	lines.push(`Loaded context (${items.length} ${items.length === 1 ? 'item' : 'items'}, ${formatTokens(totalTokens)}):`);

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
