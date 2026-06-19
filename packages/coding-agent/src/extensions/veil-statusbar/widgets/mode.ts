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

		switch (this.mode) {
			case "default":
				// Hide mode name, just show hint
				return [theme ? theme.fg("dim", "(shift+tab to cycle)") : "(shift+tab to cycle)"];

			case "auto-accept-edits":
				// Accent color with play symbols
				return [theme ? theme.fg("accent", ">> accept edits on") : ">> accept edits on"];

			case "auto":
				// Error/red warning color
				return [theme ? theme.fg("error", "auto") : "auto"];

			case "plan":
				// Warning color for read-only planning
				return [theme ? theme.fg("warning", "plan (read-only)") : "plan (read-only)"];

			default:
				return [this.mode];
		}
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
