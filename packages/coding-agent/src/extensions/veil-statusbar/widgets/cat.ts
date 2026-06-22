import type { CatState, StatusBarWidget, WidgetContext, WidgetEvent } from "../types.ts";

interface CatFrame {
	lines: [string, string, string];
	color: "dim" | "muted" | "accent" | "success" | "warning" | "error";
}

const CAT_FRAMES: Record<CatState, CatFrame> = {
	sleeping: { lines: [" /\\_/\\ ", "( -.- )", " > ^ < "], color: "dim" },
	watching: { lines: [" /\\_/\\ ", "( o.o )", " > - < "], color: "muted" },
	remembering: { lines: [" /\\_/\\ ", "( >.< )", " > ~ < "], color: "accent" },
	learned: { lines: [" /\\_/\\ ", "( ^.^ )", " > + < "], color: "success" },
	recalled: { lines: [" /\\_/\\ ", "( *.* )", " > * < "], color: "accent" }, // face randomized in render
	forgetting: { lines: [" /\\_/\\ ", "( -.- )", " > x < "], color: "error" },
	conflict: { lines: [" /\\_/\\ ", "( ?.? )", " > ! < "], color: "warning" },
};

// Random faces for recalled state
const RECALLED_FACES = ["( *.* )", "( °.° )", "( O.O )", "( @.@ )", "( $.$ )"];

const STATE_LABELS: Record<CatState, string> = {
	sleeping: "zzz...",
	watching: "watching",
	remembering: "storing...",
	learned: "learned",
	recalled: "recalled",
	forgetting: "forgetting...",
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
	private recallCounter = 0; // For cycling through recalled faces

	init(_config: Record<string, unknown>, ctx: WidgetContext): void {
		this.ctx = ctx;
	}

	render(_width: number): string[] {
		const frame = CAT_FRAMES[this.state];
		const label = STATE_LABELS[this.state];
		const detail = this.detail ? `"${this.truncate(this.detail, 18)}"` : "";
		const theme = this.ctx?.theme;

		// Pick a random face for recalled state
		const faceLines = [...frame.lines];
		if (this.state === "recalled") {
			faceLines[1] = RECALLED_FACES[this.recallCounter % RECALLED_FACES.length];
		}

		// Fixed width for consistent box size
		const textWidth = 20;
		const innerWidth = 10 + textWidth;

		// Color functions - border and face use state color, text is muted
		const colorFn = theme ? (s: string) => theme.fg(frame.color, s) : (s: string) => s;
		const mutedFn = theme ? (s: string) => theme.fg("muted", s) : (s: string) => s;
		const labelFn = theme ? (s: string) => theme.fg(frame.color, s) : (s: string) => s;

		// Colored border
		const top = colorFn(`┌${"─".repeat(innerWidth + 2)}┐`);
		const bot = colorFn(`└${"─".repeat(innerWidth + 2)}┘`);
		const vbar = colorFn("│");

		const lines: string[] = [top];
		for (let i = 0; i < 3; i++) {
			// Cat face in state color (use faceLines for recalled randomization)
			const catLine = colorFn(faceLines[i]);
			let textLine = "";
			let textFn = mutedFn;
			if (i === 0) {
				textLine = label;
				textFn = labelFn; // Label also in state color
			}
			if (i === 1 && detail) textLine = detail;

			const textPadded = textLine.padEnd(textWidth);
			const content = `${catLine}  ${textFn(textPadded)}`;
			lines.push(`${vbar} ${content}  ${vbar}`);
		}
		lines.push(bot);

		return lines;
	}

	update(event: WidgetEvent): void {
		if (event.type === "memory") {
			// Increment counter for recalled face variety
			if (event.state === "recalled") {
				this.recallCounter++;
			}
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
