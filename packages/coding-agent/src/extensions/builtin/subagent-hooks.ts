/**
 * Veil Subagent Hooks
 *
 * Thin integration layer for @tintinweb/pi-subagents.
 * Listens to subagent lifecycle events and integrates with Veil's memory system.
 *
 * Install pi-subagents: `veil install npm:@tintinweb/pi-subagents`
 * This extension auto-activates when pi-subagents emits events.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";

interface SubagentEventData {
	id: string;
	type: string;
	description: string;
	result?: string;
	error?: string;
	status: string;
	toolUses: number;
	durationMs: number;
	tokens: number;
}

export default function subagentHooksExtension(pi: ExtensionAPI): void {
	// Track active subagents for context injection
	const activeSubagents = new Map<string, { type: string; description: string; startedAt: number }>();

	// Listen for subagent start - could inject Veil context here
	pi.events.on("subagents:started", (data) => {
		const event = data as SubagentEventData;
		activeSubagents.set(event.id, {
			type: event.type,
			description: event.description,
			startedAt: Date.now(),
		});

		// TODO: Inject relevant context from Veil memory into subagent
		// This would require pi-subagents to expose a context injection API
	});

	// Listen for subagent completion - store results in Veil memory
	pi.events.on("subagents:completed", (data) => {
		const event = data as SubagentEventData;
		activeSubagents.delete(event.id);

		// TODO: Store subagent result in Veil memory for future context
		// Example: veilMemory.store({ source: "subagent", type: event.type, result: event.result })
	});

	// Listen for subagent failure - log for debugging
	pi.events.on("subagents:failed", (data) => {
		const event = data as SubagentEventData;
		activeSubagents.delete(event.id);

		// TODO: Could store failure patterns for learning
	});

	// Expose subagent status via Veil's status system
	pi.events.on("subagents:ready", () => {
		// pi-subagents is loaded and ready
	});
}
