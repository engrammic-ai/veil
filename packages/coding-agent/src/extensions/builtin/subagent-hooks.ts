/**
 * Veil Subagent Hooks
 *
 * Integration layer for pi-subagents that enables context propagation.
 * Forks the parent VeilHarness for each subagent, then merges findings back.
 *
 * Requires pi-subagents with session_ready and tools_resolve event support.
 * Install: `veil install npm:@engrammic/pi-subagents`
 */

import type { ForkResult, VeilHarness } from "@engrammic/veil-context";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const VEIL_HARNESS_KEY = Symbol.for("veil:harness");

interface ToolsResolveEvent {
	type: string;
	tools: any[];
	agentId: string;
}

interface SessionReadyEvent {
	id: string;
	type: string;
	session: { veilHarness?: VeilHarness };
	record: { description: string };
}

interface SubagentCompletedEvent {
	id: string;
	type: string;
	description: string;
	result?: string;
	status: string;
	toolUses: number;
	durationMs: number;
}

interface SubagentFailedEvent {
	id: string;
	type: string;
	error?: string;
	status: string;
}

// Track forked harnesses for merge on completion
const childHarnesses = new Map<string, ForkResult>();

/**
 * Get the parent VeilHarness from the global registry.
 */
function getParentHarness(): VeilHarness | null {
	return (globalThis as any)[VEIL_HARNESS_KEY] ?? null;
}

/**
 * Create Pi-compatible tools bound to a VeilHarness instance.
 * Tools execute against the provided harness (typically a forked child).
 */
function createVeilTools(harness: VeilHarness): any[] {
	const schemas = harness.getTools();

	return schemas.map((schema) => ({
		name: schema.name,
		label: schema.name.replace("veil_", "Veil ").replace(/_/g, " "),
		description: schema.description,
		parameters: {
			type: "object",
			properties: schema.parameters.properties,
			required: schema.parameters.required,
		},
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
			const result = await harness.executeTool(schema.name, params);
			const text = result.success
				? typeof result.data === "string"
					? result.data
					: JSON.stringify(result.data ?? "OK")
				: `Error: ${result.error ?? "Unknown error"}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { success: result.success, data: result.data },
			};
		},
	}));
}

export default function subagentHooksExtension(pi: ExtensionAPI): void {
	// Listen for tools_resolve to inject Veil tools before session creation
	// We create the fork early here so tools are bound to the child harness
	pi.events.on("subagents:tools_resolve", (data) => {
		const event = data as ToolsResolveEvent;
		const parentHarness = getParentHarness();

		if (!parentHarness) {
			return;
		}

		try {
			// Create fork early so tools execute against child harness
			const forkResult = parentHarness.fork({
				mode: "fork",
				tagPrefix: event.type,
				maxWarmInherit: 100,
			});

			// Store for session attachment and later merge
			childHarnesses.set(event.agentId, forkResult);

			// Create tools bound to the child harness and inject
			const veilTools = createVeilTools(forkResult.harness);
			event.tools.push(...veilTools);
		} catch (err) {
			console.error(`[veil] Failed to create fork for subagent ${event.agentId}:`, err);
		}
	});

	// Listen for session_ready to attach the pre-created fork to the session
	pi.events.on("subagents:session_ready", (data) => {
		const event = data as SessionReadyEvent;
		const forkResult = childHarnesses.get(event.id);

		if (!forkResult) {
			// No fork created (no parent harness was available)
			return;
		}

		// Attach child harness to the session for direct access if needed
		event.session.veilHarness = forkResult.harness;
	});

	// Listen for subagent completion - merge results back to parent
	pi.events.on("subagents:completed", async (data) => {
		const event = data as SubagentCompletedEvent;
		const forkResult = childHarnesses.get(event.id);

		if (!forkResult) {
			return;
		}

		childHarnesses.delete(event.id);
		const parentHarness = getParentHarness();

		if (!parentHarness) {
			await cleanupChild(forkResult);
			return;
		}

		try {
			const mergeResult = await parentHarness.merge(forkResult.harness, {
				minScore: 0.3,
				maxItems: 50,
				preserveProvenance: true,
				transferWeights: true,
			});

			if (mergeResult.imported > 0) {
				console.error(
					`[veil] Merged ${mergeResult.imported} items from subagent ${event.type} (skipped ${mergeResult.skipped})`,
				);
			}
		} catch (err) {
			console.error(`[veil] Failed to merge from subagent ${event.id}:`, err);
		} finally {
			await cleanupChild(forkResult);
		}
	});

	// Listen for subagent failure - cleanup without merge
	pi.events.on("subagents:failed", async (data) => {
		const event = data as SubagentFailedEvent;
		const forkResult = childHarnesses.get(event.id);

		if (!forkResult) {
			return;
		}

		childHarnesses.delete(event.id);

		// Still try to merge partial results on failure
		const parentHarness = getParentHarness();
		if (parentHarness) {
			try {
				await parentHarness.merge(forkResult.harness, {
					minScore: 0.5, // Higher threshold for failed agents
					maxItems: 20,
					preserveProvenance: true,
				});
			} catch {
				// Ignore merge errors on failure
			}
		}

		await cleanupChild(forkResult);
	});

	// pi-subagents ready
	pi.events.on("subagents:ready", () => {
		const parentHarness = getParentHarness();
		if (parentHarness) {
			console.error("[veil] Subagent context propagation enabled (fork/merge + tool injection)");
		}
	});
}

/**
 * Cleanup a child harness and its database.
 */
async function cleanupChild(forkResult: ForkResult): Promise<void> {
	try {
		await forkResult.harness.cleanup();
	} catch {
		// Non-fatal cleanup error
	}
}
