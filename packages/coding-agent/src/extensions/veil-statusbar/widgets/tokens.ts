import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class TokensWidget implements StatusBarWidget {
	id = "tokens";
	name = "Token Stats";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		// Compute cumulative usage from session entries (same as footer)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;

		if (this.ctx?.sessionManager) {
			for (const entry of this.ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					totalInput += entry.message.usage.input;
					totalOutput += entry.message.usage.output;
					totalCacheRead += entry.message.usage.cacheRead;
				}
			}
		}

		const cachedStr = this.formatTokens(totalCacheRead);
		const inputStr = this.formatTokens(totalInput);
		const outputStr = this.formatTokens(totalOutput);

		const line = `R${cachedStr}  ↑${inputStr}  ↓${outputStr}`;
		return [theme ? theme.fg("muted", line) : line];
	}

	update(_event: WidgetEvent): void {
		// Stats computed on render from sessionManager
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
