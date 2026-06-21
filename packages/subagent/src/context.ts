/**
 * Context propagation for subagents
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
 * Merge child's captures into parent (placeholder - full impl needs VeilHarness)
 */
export async function mergeSubagentContext(
	_parentDbPath: string,
	childContext: SubagentContext,
	_options: MergeOptions = {},
): Promise<MergeResult> {
	// Check if child DB exists
	if (!fs.existsSync(childContext.childDbPath)) {
		return { imported: 0, skipped: 0, childSession: childContext.sessionId };
	}

	// TODO: Full implementation requires better-sqlite3 to read child DB
	// and VeilHarness API to import items. For now, return placeholder.
	// The actual merge will be done when we have the full VeilHarness integration.

	return {
		imported: 0,
		skipped: 0,
		childSession: childContext.sessionId,
	};
}
