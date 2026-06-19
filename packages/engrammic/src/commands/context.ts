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

export interface ContextCommandOptions {
	/** Number of conversation messages */
	messageCount?: number;
	/** System prompt token estimate */
	systemPromptTokens?: number;
	/** Active MCP tools count */
	mcpToolCount?: number;
	/** Active builtin tools count */
	builtinToolCount?: number;
}

export async function renderContextCommand(
	harness: VeilHarness,
	options: ContextCommandOptions = {},
): Promise<ContextCommandOutput> {
	const window = harness.getWindow();
	const stats = await harness.getManager().getStats();
	const config = harness.getManager().getConfig();

	const lines: string[] = [];

	// Budget bar at top
	const budget = window.budget;
	const usedPercent = budget.maxTokens > 0 ? (budget.usedTokens / budget.maxTokens) * 100 : 0;
	const progressBar = formatProgressBar(usedPercent, 40);
	lines.push("");
	lines.push(`  ${progressBar}`);
	lines.push(`  ${formatTokens(budget.usedTokens)} / ${formatTokens(budget.maxTokens)} (${usedPercent.toFixed(0)}%)  evict@${(config.evictionThresholdDefault * 100).toFixed(0)}%`);
	lines.push("");

	// Context window contents
	lines.push("  ┌─ Window ─────────────────────────────────┐");

	// System prompt & tools
	if (options.systemPromptTokens !== undefined) {
		lines.push(`  │  System     ${formatTokens(options.systemPromptTokens).padStart(8)} tok            │`);
	}
	if (options.builtinToolCount !== undefined || options.mcpToolCount !== undefined) {
		const builtin = options.builtinToolCount ?? 0;
		const mcp = options.mcpToolCount ?? 0;
		lines.push(`  │  Tools      ${builtin} builtin, ${mcp} MCP`.padEnd(42) + "│");
	}
	if (options.messageCount !== undefined) {
		lines.push(`  │  Messages   ${options.messageCount}`.padEnd(42) + "│");
	}

	lines.push("  ├─ Veil Memory ────────────────────────────┤");

	// Hot items
	const hotTokens = window.items.reduce((sum, i) => sum + estimateTokens(i.content), 0);
	lines.push(`  │  ◉ Hot      ${window.items.length} items  ${formatTokens(hotTokens)} tok`.padEnd(42) + "│");

	if (window.items.length > 0) {
		for (const item of window.items.slice(0, 2)) {
			const summary = item.content.slice(0, 28).replace(/\n/g, " ").trim();
			lines.push(`  │    ${summary}...`.padEnd(42) + "│");
		}
		if (window.items.length > 2) {
			lines.push(`  │    ⋮ ${window.items.length - 2} more`.padEnd(42) + "│");
		}
	}

	// Warm/cold
	const warmTotal = stats.warm.episodic + stats.warm.fact + stats.warm.procedural;
	lines.push(`  │  ◐ Warm     ${warmTotal} items (cache)`.padEnd(42) + "│");
	lines.push(`  │  ○ Cold     ${stats.coldPointers} items (storage)`.padEnd(42) + "│");

	lines.push("  └─────────────────────────────────────────┘");
	lines.push("");

	return { lines };
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
