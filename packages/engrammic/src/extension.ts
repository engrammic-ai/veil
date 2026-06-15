/**
 * Veil Pi Extension
 *
 * Provides TUI integration for the Veil context harness.
 * Displays a real-time context usage status bar after each turn.
 *
 * Usage:
 *   import { createVeilExtension } from "@engrammic/veil/extension";
 *   // in pi config:
 *   extensions: [createVeilExtension(harness)]
 */

import type { VeilHarness } from "./harness.ts";
import { formatStatusBar } from "./ux.ts";

/**
 * Minimal subset of the Pi ExtensionAPI used here.
 * The full type lives in @earendil-works/pi-coding-agent.
 */
interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
}

interface BeforeAgentStartResult {
	systemPrompt?: string;
}

interface ExtensionAPI {
	on(event: "turn_end", handler: (event: unknown, ctx: ExtensionContext) => Promise<void>): void;
	on(
		event: "before_agent_start",
		handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => Promise<BeforeAgentStartResult | void>,
	): void;
	registerFlag(
		name: string,
		opts: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void;
	getFlag(name: string): boolean | string | undefined;
}

interface ExtensionContext {
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setToolCallDimmed(toolCallId: string, dimmed: boolean): void;
		theme: {
			fg(color: string, text: string): string;
		};
	};
}

/**
 * Factory that wires the Veil harness into Pi's extension API.
 *
 * @param harness - A VeilHarness instance whose getUsage() drives the status bar.
 * @returns An ExtensionFactory function suitable for spreading into pi config.
 *
 * @example
 * const harness = new VeilHarness({ dbPath: ".veil/context.db" });
 * const veilExtension = createVeilExtension(harness);
 * // then pass veilExtension to Pi as an extension
 */
export function createVeilExtension(harness: VeilHarness): (pi: ExtensionAPI) => void {
	return function veilExtension(pi: ExtensionAPI): void {
		pi.registerFlag("debug-tick", {
			description: "Show Veil turn counter in the status bar",
			type: "boolean",
			default: false,
		});

		pi.on("before_agent_start", async (event) => {
			const manifest = await harness.processUserMessage(event.prompt);
			if (manifest) {
				return { systemPrompt: `${event.systemPrompt}\n\n${manifest}` };
			}
		});

		pi.on("turn_end", async (_event, ctx) => {
			const usage = harness.getUsage();
			const { text, color } = formatStatusBar(usage.hotTokens, usage.budgetMax, usage.budgetReserve);

			ctx.ui.setStatus("veil-context", ctx.ui.theme.fg(color, text));

			if (pi.getFlag("debug-tick")) {
				const turnCount = harness.getTurnCount();
				ctx.ui.setStatus("veil-tick", ctx.ui.theme.fg("dim", `tick:${turnCount}`));
			} else {
				ctx.ui.setStatus("veil-tick", undefined);
			}

			// Faded history: dim tool executions whose context was evicted
			const evictedIds = harness.getAndClearEvictedToolCallIds();
			for (const toolCallId of evictedIds) {
				ctx.ui.setToolCallDimmed(toolCallId, true);
			}
		});
	};
}
