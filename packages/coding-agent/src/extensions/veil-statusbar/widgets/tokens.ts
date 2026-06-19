import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class TokensWidget implements StatusBarWidget {
	id = "tokens";
	name = "Token Stats";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private cached = 0;
	private input = 0;
	private output = 0;

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		const cachedStr = this.formatTokens(this.cached);
		const inputStr = this.formatTokens(this.input);
		const outputStr = this.formatTokens(this.output);

		const line = `Cached: ${cachedStr}  ↑${inputStr}  ↓${outputStr}`;
		return [theme ? theme.fg("muted", line) : line];
	}

	update(event: WidgetEvent): void {
		if (event.type === "session" && event.usage) {
			this.cached = event.usage.cacheRead || 0;
			this.input = event.usage.input || 0;
			this.output = event.usage.output || 0;
		}
	}

	dispose(): void {
		this.ctx = null;
	}

	private formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return String(n);
	}
}
