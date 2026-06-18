/**
 * Header cat component - ASCII cat art that shows memory state.
 */

import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type CatState = "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "conflict";

const CAT_FRAMES: Record<CatState, string[]> = {
	sleeping: ["  /\\_/\\  ", " ( z.z ) ", "  > ^ <  "],
	watching: ["  /\\_/\\  ", " ( o.o ) ", "  > - <  "],
	remembering: ["  /\\_/\\  ", " ( ~.~ ) ", "  > ~ <  "],
	learned: ["  /\\_/\\  ", " ( ^.^ ) ", "  > + <  "],
	recalled: ["  /\\_/\\  ", " ( *.* ) ", "  > * <  "],
	conflict: ["  /\\_/\\  ", " ( !.! ) ", "  > ! <  "],
};

const CAT_COLORS: Record<CatState, "dim" | "muted" | "accent" | "success" | "warning" | "error"> = {
	sleeping: "dim",
	watching: "muted",
	remembering: "accent",
	learned: "success",
	recalled: "success",
	conflict: "warning",
};

// Small emoticons for statusline
export const CAT_EMOTICONS: Record<CatState, string> = {
	sleeping: "(z.z)",
	watching: "(o.o)",
	remembering: "(~.~)",
	learned: "(^.^)",
	recalled: "(*.*)",
	conflict: "(!.!)",
};

export class HeaderCat implements Component {
	private state: CatState = "sleeping";
	private detail: string = "";
	private enabled: boolean = true;

	setState(state: CatState, detail?: string): void {
		this.state = state;
		this.detail = detail?.slice(0, 25) ?? "";
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getState(): CatState {
		return this.state;
	}

	render(_width: number): string[] {
		if (!this.enabled) return [];

		const frame = CAT_FRAMES[this.state];
		const color = CAT_COLORS[this.state];

		const coloredFrame = frame.map((line) => theme.fg(color, line));

		if (this.detail) {
			// Add detail next to the cat
			const stateLabel = theme.fg(color, this.state);
			const detailText = theme.fg("dim", this.detail);
			return [coloredFrame[0], `${coloredFrame[1]}  ${stateLabel}`, `${coloredFrame[2]}  ${detailText}`];
		}

		return coloredFrame;
	}

	invalidate(): void {
		// No cached state to invalidate
	}
}
