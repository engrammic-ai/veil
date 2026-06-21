/**
 * Veil Subagent Hooks
 *
 * Integration layer for pi-subagents that enables context propagation.
 * Forks the parent VeilHarness for each subagent, then merges findings back.
 *
 * Requires pi-subagents with session_ready event support.
 * Install: `veil install npm:@tintinweb/pi-subagents`
 */

import type { ForkResult, VeilHarness } from "@engrammic/veil-context";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const VEIL_HARNESS_KEY = Symbol.for("veil:harness");

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

export default function subagentHooksExtension(pi: ExtensionAPI): void {
	// Listen for session_ready to fork harness and attach to subagent
	pi.events.on("subagents:session_ready", (data) => {
		const event = data as SessionReadyEvent;
		const parentHarness = getParentHarness();

		if (!parentHarness) {
			// VeilHarness not available - skip context propagation
			return;
		}

		try {
			// Fork parent harness for this subagent
			const forkResult = parentHarness.fork({
				mode: "fork",
				tagPrefix: event.type,
				maxWarmInherit: 100,
			});

			// Attach child harness to the session for the subagent to use
			event.session.veilHarness = forkResult.harness;

			// Track for merge on completion
			childHarnesses.set(event.id, forkResult);
		} catch (err) {
			console.error(`[veil] Failed to fork harness for subagent ${event.id}:`, err);
		}
	});

	// Listen for subagent completion - merge results back to parent
	pi.events.on("subagents:completed", async (data) => {
		const event = data as SubagentCompletedEvent;
		const forkResult = childHarnesses.get(event.id);

		if (!forkResult) {
			// No forked harness for this subagent
			return;
		}

		childHarnesses.delete(event.id);
		const parentHarness = getParentHarness();

		if (!parentHarness) {
			// Parent harness gone - just cleanup
			await cleanupChild(forkResult);
			return;
		}

		try {
			// Merge child's findings back to parent
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
			// Cleanup child DB
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
			console.error("[veil] Subagent context propagation enabled");
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
