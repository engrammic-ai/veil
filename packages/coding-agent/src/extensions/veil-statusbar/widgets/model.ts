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
		this.modelName = ctx.modelName || "";
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;

		const name = this.modelName || "unknown";
		if (theme) {
			let line = theme.fg("accent", name);
			if (this.effort) {
				line += theme.fg("muted", " • ") + theme.fg("dim", `${this.effort} effort`);
			}
			return [line];
		}

		let line = name;
		if (this.effort) {
			line += ` • ${this.effort} effort`;
		}
		return [line];
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
