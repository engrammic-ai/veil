import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class ContextBarWidget implements StatusBarWidget {
	id = "context-bar";
	name = "Context Usage";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private contextWindow = 200000;

	init(config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
		if (typeof config.contextWindow === "number") {
			this.contextWindow = config.contextWindow;
		}
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		// Compute approximate context usage from session entries
		// This sums input tokens from assistant messages as an approximation
		let used = 0;
		if (this.ctx?.sessionManager) {
			const lastEntry = [...this.ctx.sessionManager.getEntries()]
				.reverse()
				.find((e) => e.type === "message" && e.message.role === "assistant");
			if (lastEntry?.type === "message" && lastEntry.message.role === "assistant") {
				// Use the most recent input tokens as the current context size
				used = lastEntry.message.usage.input + lastEntry.message.usage.cacheRead;
			}
		}

		const percent = this.contextWindow > 0 ? Math.round((used / this.contextWindow) * 100) : 0;
		const barWidth = 20;
		const filled = Math.round((percent / 100) * barWidth);
		const empty = barWidth - filled;

		const bar = "█".repeat(filled) + "░".repeat(empty);
		const usedK = this.formatTokens(used);
		const totalK = this.formatTokens(this.contextWindow);

		const barColored = theme ? theme.fg("accent", bar) : bar;
		const line = `Context: [${barColored}] ${usedK}/${totalK} (${percent}%)`;
		return [line];
	}

	update(_event: WidgetEvent): void {
		// Context computed on render from sessionManager
	}

	dispose(): void {
		this.ctx = null;
	}

	private formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return String(n);
	}
}
