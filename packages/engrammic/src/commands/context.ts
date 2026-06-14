import type { VeilHarness } from "../harness.ts";
import type { ContextItem } from "../types.ts";
import { formatBox, formatProgressBar } from "../ux.ts";
import { estimateTokens, formatTokens } from "../utils.ts";

export interface ContextCommandOutput {
	lines: string[];
}

const BOX_WIDTH = 60;

function formatItemLine(item: ContextItem): string {
	const tokens = estimateTokens(item.content);
	const tokStr = formatTokens(tokens).padEnd(6);
	const source = item.source.padEnd(8);
	const pinned = item.pinned ? " [pin]" : "";
	const summary = item.content.slice(0, 20).replace(/\n/g, " ").trim();

	return `  +- ${summary}...  ${tokStr} ${source}${pinned}`;
}

export function renderContextCommand(harness: VeilHarness): ContextCommandOutput {
	const window = harness.getWindow();
	const stats = harness.getManager().getStats();
	const config = harness.getManager().getConfig();

	const content: string[] = [];

	// Hot items section
	const hotTokens = window.items.reduce((sum, i) => sum + estimateTokens(i.content), 0);
	content.push("");
	content.push(`Hot (loaded):     ${window.items.length} items, ${formatTokens(hotTokens)} tokens`);

	if (window.items.length === 0) {
		content.push("  (no items loaded)");
	} else {
		for (const item of window.items.slice(0, 5)) {
			content.push(formatItemLine(item));
		}
		if (window.items.length > 5) {
			content.push(`  ... and ${window.items.length - 5} more`);
		}
	}

	content.push("");

	// Warm/cold stats
	const warmTotal = stats.warm.episodic + stats.warm.fact + stats.warm.procedural;
	content.push(`Warm (cached):    ${warmTotal} items`);
	content.push(`Cold (storage):   ${stats.coldPointers} items`);

	content.push("");

	// Budget with progress bar
	const budget = window.budget;
	const usedPercent = budget.maxTokens > 0 ? (budget.usedTokens / budget.maxTokens) * 100 : 0;
	const progressBar = formatProgressBar(usedPercent, 20);
	content.push(`Budget: ${formatTokens(budget.usedTokens)} / ${formatTokens(budget.maxTokens)} (${usedPercent.toFixed(0)}%)  ${progressBar}`);

	// Threshold
	const thresholdPercent = (config.evictionThresholdDefault * 100).toFixed(0);
	content.push(`Threshold: ${thresholdPercent}% (adaptive)`);

	content.push("");

	// Wrap in box
	const boxed = formatBox(content, "Context Window", BOX_WIDTH);

	return { lines: boxed };
}
