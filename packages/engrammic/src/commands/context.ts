import type { SearchResult, VeilHarness } from "../harness.ts";
import type { ContextItem } from "../types.ts";
import { estimateTokens, formatTokens } from "../utils.ts";
import { formatBox, formatProgressBar } from "../ux.ts";

export type { SearchResult };

export interface ContextCommandOutput {
	lines: string[];
}

const BOX_WIDTH = 60;

// ANSI color helpers
const c = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	pink: "\x1b[38;5;205m",
	orange: "\x1b[38;5;208m",
	cyan: "\x1b[38;5;51m",
	green: "\x1b[38;5;42m",
	yellow: "\x1b[38;5;220m",
	blue: "\x1b[38;5;75m",
};

function _formatItemLine(item: ContextItem): string {
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
	lines.push(
		`  ${formatTokens(budget.usedTokens)} / ${formatTokens(budget.maxTokens)} (${usedPercent.toFixed(0)}%)  evict@${(config.evictionThresholdDefault * 100).toFixed(0)}%`,
	);
	lines.push("");

	// Box with context info
	const W = 44;
	const pad = (s: string, visualLen: number) => s + " ".repeat(Math.max(0, W - 4 - visualLen));
	const boxBorder = `${c.dim}`;

	lines.push(`  ${boxBorder}╭${"─".repeat(W - 2)}╮${c.reset}`);

	if (options.systemPromptTokens !== undefined) {
		const content = `${c.blue}System${c.reset}      ${formatTokens(options.systemPromptTokens)}`;
		lines.push(
			`  ${boxBorder}│${c.reset} ${pad(content, 6 + 6 + formatTokens(options.systemPromptTokens).length)} ${boxBorder}│${c.reset}`,
		);
	}
	if (options.builtinToolCount !== undefined || options.mcpToolCount !== undefined) {
		const builtin = options.builtinToolCount ?? 0;
		const mcp = options.mcpToolCount ?? 0;
		const text = `${builtin} builtin, ${mcp} MCP`;
		const content = `${c.cyan}Tools${c.reset}       ${text}`;
		lines.push(`  ${boxBorder}│${c.reset} ${pad(content, 5 + 7 + text.length)} ${boxBorder}│${c.reset}`);
	}
	if (options.messageCount !== undefined) {
		const content = `${c.blue}Messages${c.reset}    ${options.messageCount}`;
		lines.push(
			`  ${boxBorder}│${c.reset} ${pad(content, 8 + 4 + String(options.messageCount).length)} ${boxBorder}│${c.reset}`,
		);
	}

	lines.push(`  ${boxBorder}├${"─".repeat(W - 2)}┤${c.reset}`);

	// Memory tiers with icons
	const hotTokens = window.items.reduce((sum, i) => sum + estimateTokens(i.content), 0);
	const hotText = `${window.items.length} items  ${formatTokens(hotTokens)}`;
	const hotContent = `${c.orange}◉${c.reset} ${c.orange}Hot${c.reset}       ${hotText}`;
	lines.push(`  ${boxBorder}│${c.reset} ${pad(hotContent, 1 + 1 + 3 + 7 + hotText.length)} ${boxBorder}│${c.reset}`);

	if (window.items.length > 0) {
		for (const item of window.items.slice(0, 2)) {
			const summary = item.content.slice(0, 30).replace(/\n/g, " ").trim();
			const content = `${c.dim}  ${summary}...${c.reset}`;
			lines.push(`  ${boxBorder}│${c.reset} ${pad(content, 2 + summary.length + 3)} ${boxBorder}│${c.reset}`);
		}
		if (window.items.length > 2) {
			const content = `${c.dim}  +${window.items.length - 2} more${c.reset}`;
			lines.push(
				`  ${boxBorder}│${c.reset} ${pad(content, 2 + 1 + String(window.items.length - 2).length + 5)} ${boxBorder}│${c.reset}`,
			);
		}
	}

	const warmTotal = stats.warm.episodic + stats.warm.fact + stats.warm.procedural;
	const warmText = `${warmTotal} items`;
	const warmContent = `${c.yellow}◐${c.reset} ${c.yellow}Cached${c.reset}    ${warmText}`;
	lines.push(`  ${boxBorder}│${c.reset} ${pad(warmContent, 1 + 1 + 6 + 4 + warmText.length)} ${boxBorder}│${c.reset}`);

	const coldText = `${stats.coldPointers} items`;
	const coldContent = `${c.blue}○${c.reset} ${c.blue}Storage${c.reset}   ${coldText}`;
	lines.push(`  ${boxBorder}│${c.reset} ${pad(coldContent, 1 + 1 + 7 + 3 + coldText.length)} ${boxBorder}│${c.reset}`);

	// Embedder/semantic search status
	const coldStats = harness.getManager().getColdStats?.();
	if (coldStats?.embedderStatus) {
		const statusIcon =
			coldStats.embedderStatus === "active"
				? `${c.green}on${c.reset}`
				: coldStats.embedderStatus === "failed"
					? `${c.orange}FAILED${c.reset}`
					: `${c.dim}off${c.reset}`;
		const errorSuffix = coldStats.embedderError ? ` ${c.dim}(${coldStats.embedderError.slice(0, 20)})${c.reset}` : "";
		const statusText = `${statusIcon}${errorSuffix}`;
		const semanticContent = `  ${c.cyan}Semantic${c.reset}  ${statusText}`;
		// Approximate visual length (varies with color codes)
		lines.push(`  ${boxBorder}│${c.reset} ${pad(semanticContent, 2 + 8 + 2 + 6)} ${boxBorder}│${c.reset}`);
	}

	lines.push(`  ${boxBorder}╰${"─".repeat(W - 2)}╯${c.reset}`);
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
