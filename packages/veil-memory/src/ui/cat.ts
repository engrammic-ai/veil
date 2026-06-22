/**
 * ASCII cat widget for memory companion visualization.
 */

import type { CatConfig, CatState, SessionStats } from "../types.ts";

const UNICODE_FRAMES = {
	sleeping: `   /\\_/\\
  ( o.o )
   > ^ <`,
	watching: `   /\\_/\\
  ( o.o )
   > - <`,
	remembering: `   /\\_/\\
  ( ◕.◕ )
   > ~ <`,
	learned: `   /\\_/\\
  ( ^.^ )
   > ♥ <`,
	recalled: `   /\\_/\\
  ( ^.^ )
   > ♦ <`,
	forgetting: `   /\\_/\\
  ( x.x )
   > - <`,
	conflict: `   /\\_/\\
  ( o.o )
   > ! <`,
};

const ASCII_FRAMES = {
	sleeping: `   /\\_/\\
  ( o.o )
   > ^ <`,
	watching: `   /\\_/\\
  ( o.o )
   > - <`,
	remembering: `   /\\_/\\
  ( o.o )
   > ~ <`,
	learned: `   /\\_/\\
  ( ^.^ )
   > + <`,
	recalled: `   /\\_/\\
  ( ^.^ )
   > * <`,
	forgetting: `   /\\_/\\
  ( x.x )
   > - <`,
	conflict: `   /\\_/\\
  ( o.o )
   > ! <`,
};

export const DEFAULT_CAT_CONFIG: CatConfig = {
	enabled: true,
	position: "statusbar",
	mode: "auto",
	minimal: false,
};

export class CatWidget {
	private config: CatConfig;
	private currentState: CatState = { state: "sleeping" };
	private useUnicode: boolean;

	constructor(config: Partial<CatConfig> = {}) {
		this.config = { ...DEFAULT_CAT_CONFIG, ...config };
		this.useUnicode = this.detectUnicodeSupport();
	}

	private detectUnicodeSupport(): boolean {
		if (this.config.mode === "unicode") return true;
		if (this.config.mode === "ascii") return false;

		if (typeof process !== "undefined") {
			const term = process.env.TERM || "";
			const isWindows = process.platform === "win32";
			const isSSH = !!process.env.SSH_CONNECTION;

			if (isWindows && !process.env.WT_SESSION) return false;
			if (isSSH && !term.includes("256color") && !term.includes("xterm")) return false;
		}

		return true;
	}

	setState(state: CatState): void {
		this.currentState = state;
	}

	getState(): CatState {
		return this.currentState;
	}

	render(): string {
		if (!this.config.enabled || this.config.position === "off") {
			return "";
		}

		const frames = this.useUnicode ? UNICODE_FRAMES : ASCII_FRAMES;
		const frame = frames[this.currentState.state];

		if (this.config.minimal) {
			return this.renderMinimal();
		}

		if (this.currentState.detail) {
			return `${frame}     ${this.currentState.state}\n     ${this.currentState.detail}`;
		}

		return `${frame}     ${this.currentState.state}`;
	}

	private renderMinimal(): string {
		const stateChar = {
			sleeping: "z",
			watching: ".",
			remembering: "~",
			learned: "+",
			recalled: "*",
			forgetting: "x",
			conflict: "!",
		}[this.currentState.state];

		return `memory: [${stateChar}]${this.currentState.detail ? ` ${this.currentState.detail}` : ""}`;
	}

	renderSessionEnd(stats: SessionStats): string {
		const frames = this.useUnicode ? UNICODE_FRAMES : ASCII_FRAMES;
		const frame = frames.learned;

		return `${frame}     SESSION END
    remembered: ${stats.remembered} | learned: ${stats.learned} | recalled: ${stats.recalled}
    stability avg: ${stats.stabilityAvg.toFixed(1)} days | conflicts: ${stats.conflicts} | evicted: ${stats.evicted}`;
	}

	formatAnnotation(type: "recalled" | "learned" | "reinforced" | "conflict", detail: string): string {
		return `[${type}: ${detail}]`;
	}
}
