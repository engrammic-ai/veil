import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

const VEIL_HARNESS_KEY = Symbol.for("veil:harness");

export class ContextBarWidget implements StatusBarWidget {
	id = "context-bar";
	name = "Context Usage";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private contextWindow = 200000;
	private harnessUsage: { hotTokens: number; budgetMax: number; percent: number } | null = null;
	private unsubscribe: (() => void) | null = null;

	init(config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
		if (typeof config.contextWindow === "number") {
			this.contextWindow = config.contextWindow;
		}

		// Subscribe to harness memory events for real-time usage updates
		const harness = (globalThis as any)[VEIL_HARNESS_KEY];
		if (harness?.onMemoryEvent) {
			this.unsubscribe = harness.onMemoryEvent(
				(event: { usage?: { hotTokens: number; budgetMax: number; percent: number } }) => {
					if (event.usage) {
						this.harnessUsage = event.usage;
					}
				},
			);
		}
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		// Get API context usage from session entries
		let apiUsed = 0;
		if (this.ctx?.sessionManager) {
			const lastEntry = [...this.ctx.sessionManager.getEntries()]
				.reverse()
				.find((e) => e.type === "message" && e.message.role === "assistant");
			if (lastEntry?.type === "message" && lastEntry.message.role === "assistant") {
				apiUsed = lastEntry.message.usage.input + lastEntry.message.usage.cacheRead;
			}
		}

		const apiPercent = this.contextWindow > 0 ? Math.round((apiUsed / this.contextWindow) * 100) : 0;
		const barWidth = 16;
		const filled = Math.round((apiPercent / 100) * barWidth);
		const empty = barWidth - filled;

		const bar = "█".repeat(filled) + "░".repeat(empty);
		const apiUsedK = this.formatTokens(apiUsed);
		const totalK = this.formatTokens(this.contextWindow);

		const barColored = theme ? theme.fg("accent", bar) : bar;

		// Build line with API usage and harness budget if available
		let line = `API: [${barColored}] ${apiUsedK}/${totalK}`;

		if (this.harnessUsage) {
			const hotK = this.formatTokens(this.harnessUsage.hotTokens);
			const budgetK = this.formatTokens(this.harnessUsage.budgetMax);
			const hPercent = Math.round(this.harnessUsage.percent);
			line += ` | Hot: ${hotK}/${budgetK} (${hPercent}%)`;
		}

		return [line];
	}

	update(_event: WidgetEvent): void {
		// Context computed on render from sessionManager
		// Harness usage updated via memory event subscription
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.ctx = null;
	}

	private formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return String(n);
	}
}
