/**
 * Cat status box - floating right-aligned box showing memory companion state.
 * Adapts to terminal height: full box on large terminals, single line on small.
 */

import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type CatState = "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "conflict";

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

// Threshold for switching to compact mode
const COMPACT_HEIGHT_THRESHOLD = 30;

export class CatStatusBox implements Component {
	private state: CatState = "watching";
	private detail: string = "";
	private enabled: boolean = true;
	private terminalHeight: number = 40;

	setState(state: CatState, detail?: string): void {
		this.state = state;
		this.detail = detail ?? "";
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	setTerminalHeight(height: number): void {
		this.terminalHeight = height;
	}

	isCompactMode(): boolean {
		return this.terminalHeight < COMPACT_HEIGHT_THRESHOLD;
	}

	render(width: number): string[] {
		if (!this.enabled) return [];

		if (this.isCompactMode()) {
			return this.renderCompact(width);
		}

		return this.renderFull(width);
	}

	private renderCompact(width: number): string[] {
		const frame = CAT_FRAMES[this.state];
		const face = frame.lines[1]; // Just the face line
		const label = STATE_LABELS[this.state];
		const detail = this.detail ? ` "${this.truncate(this.detail, 20)}"` : "";

		const content = `${face} ${label}${detail}`;
		const colored = theme.fg(frame.color, content);
		const padded = this.rightAlign(colored, width);

		return [padded];
	}

	private renderFull(width: number): string[] {
		const frame = CAT_FRAMES[this.state];
		const label = STATE_LABELS[this.state];
		const detail = this.detail ? `"${this.truncate(this.detail, 18)}"` : "";

		// Box dimensions
		const catWidth = 7; // width of cat art
		const textWidth = Math.max(label.length, detail.length);
		const innerWidth = catWidth + 1 + textWidth; // cat + space + text
		const _boxWidth = innerWidth + 4; // borders + padding

		const borderColor = frame.color;
		const top = theme.fg(borderColor, `┌${"─".repeat(innerWidth + 2)}┐`);
		const bot = theme.fg(borderColor, `└${"─".repeat(innerWidth + 2)}┘`);
		const vbar = theme.fg(borderColor, "│");

		// Build content lines
		const lines: string[] = [top];

		for (let i = 0; i < 3; i++) {
			const catLine = theme.fg(frame.color, frame.lines[i]);
			let textLine = "";
			if (i === 0) textLine = label;
			if (i === 1 && detail) textLine = detail;

			const textPadded = textLine.padEnd(textWidth);
			const content = `${catLine} ${theme.fg("muted", textPadded)}`;
			const innerPadded = this.padToWidth(content, innerWidth);
			lines.push(`${vbar} ${innerPadded} ${vbar}`);
		}

		lines.push(bot);

		// Right-align the whole box
		return lines.map((line) => this.rightAlign(line, width));
	}

	private truncate(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		return `${text.slice(0, maxLen - 1)}…`;
	}

	private rightAlign(text: string, width: number): string {
		const textWidth = visibleWidth(text);
		const padding = Math.max(0, width - textWidth);
		return " ".repeat(padding) + text;
	}

	private padToWidth(text: string, targetWidth: number): string {
		const currentWidth = visibleWidth(text);
		const padding = Math.max(0, targetWidth - currentWidth);
		return text + " ".repeat(padding);
	}

	invalidate(): void {
		// No cached state
	}
}
