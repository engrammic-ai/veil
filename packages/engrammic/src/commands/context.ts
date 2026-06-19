import type { SearchResult, VeilHarness } from "../harness.ts";
import type { ContextItem } from "../types.ts";
import { estimateTokens, formatTokens } from "../utils.ts";
import { formatBox, formatProgressBar } from "../ux.ts";

export type { SearchResult };

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

export async function renderContextCommand(harness: VeilHarness): Promise<ContextCommandOutput> {
	const window = harness.getWindow();
	const stats = await harness.getManager().getStats();
	const config = harness.getManager().getConfig();

	const content: string[] = [];

	// Hot items section with visual indicator
	const hotTokens = window.items.reduce((sum, i) => sum + estimateTokens(i.content), 0);
	content.push("");
	content.push(`  ◉ Hot (loaded)    ${window.items.length} items  ${formatTokens(hotTokens)} tok`);

	if (window.items.length === 0) {
		content.push("      (empty)");
	} else {
		for (const item of window.items.slice(0, 3)) {
			content.push(formatItemLine(item));
		}
		if (window.items.length > 3) {
			content.push(`      ⋮ ${window.items.length - 3} more`);
		}
	}

	content.push("");

	// Warm/cold with visual indicators
	const warmTotal = stats.warm.episodic + stats.warm.fact + stats.warm.procedural;
	content.push(`  ◐ Warm (cached)   ${warmTotal} items`);
	content.push(`  ○ Cold (storage)  ${stats.coldPointers} items`);

	content.push("");
	content.push("  ─".repeat(25));
	content.push("");

	// Budget with progress bar
	const budget = window.budget;
	const usedPercent = budget.maxTokens > 0 ? (budget.usedTokens / budget.maxTokens) * 100 : 0;
	const progressBar = formatProgressBar(usedPercent, 24);
	content.push(`  ${progressBar}`);
	content.push(
		`  ${formatTokens(budget.usedTokens)} / ${formatTokens(budget.maxTokens)} (${usedPercent.toFixed(0)}%)`,
	);

	// Threshold
	const thresholdPercent = (config.evictionThresholdDefault * 100).toFixed(0);
	content.push(`  Eviction: ${thresholdPercent}%`);

	content.push("");

	// Wrap in box
	const boxed = formatBox(content, "Veil Context", BOX_WIDTH);

	return { lines: boxed };
}

export async function renderContextSearch(harness: VeilHarness, query: string): Promise<ContextCommandOutput> {
	const results = harness.search(query, 10);

	const content: string[] = [];
	content.push("");
	content.push(`  Search: "${query}"`);
	content.push("");

	if (results.length === 0) {
		content.push("    (no results)");
	} else {
		const tierIcons: Record<string, string> = { hot: "◉", warm: "◐", cold: "○" };
		for (const result of results) {
			const icon = tierIcons[result.tier] || "·";
			const idShort = result.id.slice(0, 6);
			const typeAndSummary = `${result.type}:${result.summary}`.slice(0, 32);
			const tokStr = formatTokens(result.tokens);
			content.push(`  ${icon} ${idShort}  ${typeAndSummary}  ${tokStr}`);
		}
	}

	content.push("");

	// Summary line
	if (results.length > 0) {
		const hotCount = results.filter((r) => r.tier === "hot").length;
		const warmCount = results.filter((r) => r.tier === "warm").length;
		const coldCount = results.filter((r) => r.tier === "cold").length;
		const parts: string[] = [];
		if (hotCount > 0) parts.push(`◉${hotCount}`);
		if (warmCount > 0) parts.push(`◐${warmCount}`);
		if (coldCount > 0) parts.push(`○${coldCount}`);
		content.push(`  Found ${results.length}  (${parts.join(" ")})`);
	}

	content.push("");

	const boxed = formatBox(content, "Veil Search", BOX_WIDTH);
	return { lines: boxed };
}
