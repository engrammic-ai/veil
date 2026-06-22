import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

const VEIL_HARNESS_KEY = Symbol.for("veil:harness");

interface UsageStats {
	contextPercent: number;
	hotTokens: number;
	hotItems: number;
	budgetMax: number;
	budgetUsed: number;
}

export class ContextBarWidget implements StatusBarWidget {
	id = "context-bar";
	name = "Context Usage";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private contextWindow = 200000;
	private usage: UsageStats | null = null;
	private unsubscribe: (() => void) | null = null;

	init(config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
		if (typeof config.contextWindow === "number") {
			this.contextWindow = config.contextWindow;
		}

		// Subscribe to harness memory events for real-time usage updates
		const harness = (globalThis as any)[VEIL_HARNESS_KEY];
		if (harness?.onMemoryEvent) {
			this.unsubscribe = harness.onMemoryEvent((event: { usage?: UsageStats }) => {
				if (event.usage) {
					this.usage = event.usage;
				}
			});
		}
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		// Use harness-reported context percent if available, else compute from session
		let percent = 0;
		let tokensUsed = 0;

		if (this.usage?.contextPercent != null) {
			percent = Math.round(this.usage.contextPercent);
			tokensUsed = Math.round((percent / 100) * this.contextWindow);
		} else if (this.ctx?.sessionManager) {
			// Fallback: compute from last assistant message
			const lastEntry = [...this.ctx.sessionManager.getEntries()]
				.reverse()
				.find((e) => e.type === "message" && e.message.role === "assistant");
			if (lastEntry?.type === "message" && lastEntry.message.role === "assistant") {
				tokensUsed = lastEntry.message.usage.input + lastEntry.message.usage.cacheRead;
				percent = this.contextWindow > 0 ? Math.round((tokensUsed / this.contextWindow) * 100) : 0;
			}
		}

		const barWidth = 20;
		const filled = Math.round((percent / 100) * barWidth);
		const empty = barWidth - filled;

		const bar = "█".repeat(filled) + "░".repeat(empty);
		const usedK = this.formatTokens(tokensUsed);
		const totalK = this.formatTokens(this.contextWindow);

		// Color bar based on usage
		let barColored = bar;
		if (theme) {
			if (percent >= 90) {
				barColored = theme.fg("error", bar);
			} else if (percent >= 75) {
				barColored = theme.fg("warning", bar);
			} else {
				barColored = theme.fg("accent", bar);
			}
		}

		const line = `Context: [${barColored}] ${usedK}/${totalK} (${percent}%)`;
		return [line];
	}

	update(_event: WidgetEvent): void {
		// Usage updated via memory event subscription
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
