/**
 * Header cat component - small colored cat face that shows memory state.
 */

import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type CatState = "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "conflict";

const CAT_FACES: Record<CatState, string> = {
	sleeping: "(z.z)",
	watching: "(o.o)",
	remembering: "(~.~)",
	learned: "(^.^)",
	recalled: "(*.*)",
	conflict: "(!.!)",
};

const CAT_COLORS: Record<CatState, "dim" | "muted" | "accent" | "success" | "warning" | "error"> = {
	sleeping: "dim",
	watching: "muted",
	remembering: "accent",
	learned: "success",
	recalled: "success",
	conflict: "warning",
};

export class HeaderCat implements Component {
	private state: CatState = "sleeping";
	private detail: string = "";
	private enabled: boolean = true;

	setState(state: CatState, detail?: string): void {
		this.state = state;
		this.detail = detail?.slice(0, 20) ?? "";
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	render(_width: number): string[] {
		if (!this.enabled) return [];

		const face = CAT_FACES[this.state];
		const color = CAT_COLORS[this.state];
		const coloredFace = theme.fg(color, face);

		if (this.detail) {
			return [`${coloredFace} ${theme.fg("dim", this.detail)}`];
		}
		return [coloredFace];
	}

	invalidate(): void {
		// No cached state to invalidate
	}
}
