import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class ContextBarWidget implements StatusBarWidget {
	id = "context-bar";
	name = "Context Usage";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private used = 0;
	private total = 200000;

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;
		const percent = this.total > 0 ? Math.round((this.used / this.total) * 100) : 0;
		const barWidth = 20;
		const filled = Math.round((percent / 100) * barWidth);
		const empty = barWidth - filled;

		const bar = "█".repeat(filled) + "░".repeat(empty);
		const usedK = this.formatTokens(this.used);
		const totalK = this.formatTokens(this.total);

		const line = `Context: [${bar}] ${usedK}/${totalK} (${percent}%)`;
		return [theme ? theme.fg("dim", line) : line];
	}

	update(event: WidgetEvent): void {
		if (event.type === "session" && event.usage) {
			this.used = event.usage.input || 0;
		}
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
