import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class ModelWidget implements StatusBarWidget {
	id = "model";
	name = "Model Info";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private modelName = "";
	private effort = "";

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
		const footer = ctx.footerData;
		if (typeof (footer as Record<string, unknown>).getModel === "function") {
			this.modelName = ((footer as Record<string, unknown>).getModel as () => string)() || "";
		}
		if (typeof (footer as Record<string, unknown>).getEffort === "function") {
			this.effort = ((footer as Record<string, unknown>).getEffort as () => string)() || "";
		}
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		let line = this.modelName || "unknown";
		if (this.effort) {
			line += ` • ${this.effort} effort`;
		}

		return [theme ? theme.fg("dim", line) : line];
	}

	update(event: WidgetEvent): void {
		if (event.type === "session" && event.usage) {
			// model/effort arrive via setModel; usage events carry token counts only
		}
	}

	setModel(name: string, effort?: string): void {
		this.modelName = name;
		this.effort = effort || "";
	}

	dispose(): void {
		this.ctx = null;
	}
}
