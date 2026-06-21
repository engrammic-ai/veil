/**
 * Context propagation for subagents
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { VeilHarness } from "@engrammic/veil-context";
import { ipcPath } from "./ipc.ts";
import type { MergeOptions, MergeResult, SubagentContext, SubagentContextOptions } from "./types.ts";

/**
 * Create isolated context for a subagent
 */
export function createSubagentContext(
	parentDbPath: string,
	parentSessionId: string,
	options: SubagentContextOptions,
): SubagentContext {
	const timestamp = Date.now();
	const sessionId = `${parentSessionId}:${options.tag}:${timestamp}`;

	// Sanitize for filesystem
	const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");

	// Child DB in .children subdirectory
	const childrenDir = `${parentDbPath}.children`;
	if (!fs.existsSync(childrenDir)) {
		fs.mkdirSync(childrenDir, { recursive: true });
	}
	const childDbPath = path.join(childrenDir, `${safeSessionId}.db`);

	// IPC socket path
	const socketPath = ipcPath(parentSessionId, options.tag);

	return {
		sessionId,
		parentDbPath,
		childDbPath,
		ipcPath: socketPath,
		tag: options.tag,
		async cleanup() {
			try {
				fs.rmSync(childDbPath, { force: true });
				fs.rmSync(`${childDbPath}-shm`, { force: true });
				fs.rmSync(`${childDbPath}-wal`, { force: true });
			} catch {}
			try {
				fs.rmSync(socketPath, { force: true });
			} catch {}
		},
	};
}

/**
 * Merge child's captures into parent via VeilHarness.importFromDb().
 *
 * @param harness The parent's VeilHarness instance
 * @param childContext The child's SubagentContext
 * @param options Merge options (transferWeights)
 * @returns Merge result with import counts
 */
export async function mergeSubagentContext(
	harness: VeilHarness,
	childContext: SubagentContext,
	options: MergeOptions = {},
): Promise<MergeResult> {
	// Check if child DB exists
	if (!fs.existsSync(childContext.childDbPath)) {
		return { imported: 0, skipped: 0, childSession: childContext.sessionId };
	}

	const result = await harness.importFromDb(childContext.childDbPath, {
		tag: childContext.tag,
		sessionId: childContext.sessionId,
		transferWeights: options.transferWeights ?? true,
	});

	return {
		imported: result.imported,
		skipped: result.skipped,
		childSession: childContext.sessionId,
	};
}
