import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class ModeWidget implements StatusBarWidget {
	id = "mode";
	name = "Permission Mode";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private mode = "default";

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
		this.mode = ctx.permissionMode || "default";
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;
		const modeColored = theme ? theme.fg("accent", this.mode) : this.mode;
		const line = `mode: ${modeColored}`;
		return [line];
	}

	update(event: WidgetEvent): void {
		if (event.type === "mode") {
			this.mode = event.mode;
		}
	}

	dispose(): void {
		this.ctx = null;
	}
}
