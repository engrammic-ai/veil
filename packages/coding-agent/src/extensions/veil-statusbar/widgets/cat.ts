import type { CatState, StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

interface CatFrame {
	lines: [string, string, string];
	color: "dim" | "muted" | "accent" | "success" | "warning";
}

const CAT_FRAMES: Record<CatState, CatFrame> = {
	sleeping: { lines: [" /\\_/\\ ", "( z.z )", " > ^ < "], color: "dim" },
	watching: { lines: [" /\\_/\\ ", "( o.o )", " > - < "], color: "muted" },
	remembering: { lines: [" /\\_/\\ ", "( ~.~ )", " > ~ < "], color: "accent" },
	learned: { lines: [" /\\_/\\ ", "( ^.^ )", " > + < "], color: "success" },
	recalled: { lines: [" /\\_/\\ ", "( *.* )", " > * < "], color: "success" },
	conflict: { lines: [" /\\_/\\ ", "( !.! )", " > ! < "], color: "warning" },
};

const STATE_LABELS: Record<CatState, string> = {
	sleeping: "zzz...",
	watching: "watching",
	remembering: "storing...",
	learned: "learned",
	recalled: "recalled",
	conflict: "conflict!",
};

export class CatWidget implements StatusBarWidget {
	id = "cat";
	name = "Memory Cat";
	defaultSide: "left" | "right" = "right";
	lines = 5; // 3 cat lines + top/bottom border

	private state: CatState = "watching";
	private detail: string = "";
	private ctx: WidgetContext | null = null;

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
	}

	render(_width: number): string[] {
		const frame = CAT_FRAMES[this.state];
		const label = STATE_LABELS[this.state];
		const detail = this.detail ? `"${this.truncate(this.detail, 32)}"` : "";
		const theme = this.ctx?.theme;

		const minTextWidth = 20;
		const textWidth = Math.max(minTextWidth, label.length, detail.length);
		// Middle line = │ + space + cat(7) + gap(2) + text + pad(2) + │ = 14 + textWidth
		// Border = ┌ + dashes(innerWidth+2) + ┐ = innerWidth + 4
		// Match: innerWidth + 4 = 14 + textWidth => innerWidth = 10 + textWidth
		const innerWidth = 10 + textWidth;

		const colorFn = theme ? (s: string) => theme.fg(frame.color, s) : (s: string) => s;
		const mutedFn = theme ? (s: string) => theme.fg("muted", s) : (s: string) => s;

		const top = colorFn(`┌${"─".repeat(innerWidth + 2)}┐`);
		const bot = colorFn(`└${"─".repeat(innerWidth + 2)}┘`);
		const vbar = colorFn("│");

		const lines: string[] = [top];
		for (let i = 0; i < 3; i++) {
			const catLine = colorFn(frame.lines[i]);
			let textLine = "";
			if (i === 0) textLine = label;
			if (i === 1 && detail) textLine = detail;

			const textPadded = textLine.padEnd(textWidth);
			const content = `${catLine}  ${mutedFn(textPadded)}`;
			lines.push(`${vbar} ${content}  ${vbar}`);
		}
		lines.push(bot);

		return lines;
	}

	update(event: WidgetEvent): void {
		if (event.type === "memory") {
			this.state = event.state;
			this.detail = event.detail || "";
		}
	}

	dispose(): void {
		this.ctx = null;
	}

	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return `${text.slice(0, maxLen - 1)}…`;
	}
}
