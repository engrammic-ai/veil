import type { VeilHarness } from "@engrammic/veil-context";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export type CatState = "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "conflict";

export type WidgetEvent =
	| { type: "memory"; state: CatState; detail?: string }
	| { type: "session"; usage: TokenUsage }
	| { type: "git"; branch: string; diff?: { added: number; removed: number } }
	| { type: "resize"; width: number; height: number }
	| { type: "mode"; mode: string };

export interface WidgetContext {
	session: AgentSession;
	veilHarness?: VeilHarness;
	footerData: ReadonlyFooterDataProvider;
	theme: Theme;
	terminal: { width: number; height: number };
}

export interface StatusBarWidget {
	/** Unique identifier, matches config keys */
	id: string;

	/** Human-readable name for UI/docs */
	name: string;

	/** Which side it prefers (can be overridden) */
	defaultSide: "left" | "right";

	/** How many lines this widget needs (1-5) */
	lines: number;

	/** Config schema for validation (optional) */
	configSchema?: object;

	/** Initialize with config + dependencies */
	init(config: Record<string, unknown>, ctx: WidgetContext): void;

	/** Render to string array (one per line) */
	render(width: number): string[];

	/** Called on state changes (memory events, session updates, etc.) */
	update(event: WidgetEvent): void;

	/** Cleanup */
	dispose?(): void;
}

export interface StatusBarConfig {
	preset?: "full" | "minimal" | "demo";
	left?: string[];
	right?: string[];
	hide?: string[];
	widgets?: {
		[widgetId: string]: Record<string, unknown>;
	};
}
