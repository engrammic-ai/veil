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

			case "acceptEdits":
				// Accent for auto-approve edits
				return [theme ? theme.fg("accent", ">> accept edits") : ">> accept edits"];

			case "auto":
				// Warning - most permissive
				return [theme ? theme.fg("error", "auto") : "auto"];

			case "plan":
				// Muted for read-only
				return [theme ? theme.fg("warning", "plan (read-only)") : "plan (read-only)"];

			case "dontAsk":
				// For CI - auto-deny
				return [theme ? theme.fg("muted", "dontAsk (CI)") : "dontAsk (CI)"];

			case "bypassPermissions":
				// Dangerous red
				return [theme ? theme.fg("error", "!! BYPASS !!") : "!! BYPASS !!"];

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
