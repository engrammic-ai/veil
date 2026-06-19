import type { StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

export class ProjectWidget implements StatusBarWidget {
	id = "project";
	name = "Project Info";
	defaultSide: "left" | "right" = "left";
	lines = 1;

	private ctx: WidgetContext | null = null;
	private branch: string = "";
	private diff: { added: number; removed: number } | null = null;

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
		this.branch = ctx.footerData.getGitBranch() || "";
	}

	render(_width: number): string[] {
		const theme = this.ctx?.theme;
		const cwd = this.formatCwd();

		let line = theme ? theme.fg("muted", cwd) : cwd;
		if (this.branch) {
			const branchStr = theme ? theme.fg("accent", this.branch) : this.branch;
			line += ` ${theme ? theme.fg("dim", "(") : "("}${branchStr}${theme ? theme.fg("dim", ")") : ")"}`;
		}
		if (this.diff) {
			const added = theme ? theme.fg("success", `+${this.diff.added}`) : `+${this.diff.added}`;
			const removed = theme ? theme.fg("error", `-${this.diff.removed}`) : `-${this.diff.removed}`;
			line += ` ${added} ${removed}`;
		}

		return [line];
	}

	update(event: WidgetEvent): void {
		if (event.type === "git") {
			this.branch = event.branch;
			this.diff = event.diff || null;
		}
	}

	dispose(): void {
		this.ctx = null;
	}

	private formatCwd(): string {
		const cwd = this.ctx?.sessionManager?.getCwd() || process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE || "";
		if (home && cwd.startsWith(home)) {
			return `~${cwd.slice(home.length)}`;
		}
		return cwd;
	}
}
