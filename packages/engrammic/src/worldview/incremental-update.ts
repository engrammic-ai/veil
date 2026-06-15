/**
 * Incremental worldview update: re-parse and re-index a file only when its
 * mtime has changed since we last processed it.
 *
 * Usage:
 *   const result = await checkAndUpdateFile(filePath, content, parser, store, tracker);
 *   if (result.skipped) { /* file unchanged, symbols already current *\/ }
 */

import type { FileTracker } from "./file-tracker.ts";
import type { TreeSitterParser } from "./parser.ts";
import type { SymbolStore } from "./symbol-store.ts";
import { SymbolExtractor } from "./symbols.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IncrementalUpdateResult {
	/** True when the file was unchanged and no re-extraction was performed. */
	skipped: boolean;
	/** Number of symbols written (0 when skipped or extraction returned nothing). */
	symbolCount: number;
	/** The mtime that was recorded (null when skipped). */
	mtime: number | null;
}

// ---------------------------------------------------------------------------
// checkAndUpdateFile
// ---------------------------------------------------------------------------

/**
 * Check whether `filePath` has changed since the last time it was indexed.
 * If unchanged, return early (skipped=true).  If changed (or never seen),
 * extract symbols from `content` and write them to `symbolStore`, then
 * update the mtime record in `fileTracker`.
 *
 * The caller is responsible for reading `content` from disk and providing
 * an initialised `parser` (TreeSitterParser.init() already called).
 */
export async function checkAndUpdateFile(
	filePath: string,
	content: string,
	parser: TreeSitterParser,
	symbolStore: SymbolStore,
	fileTracker: FileTracker,
): Promise<IncrementalUpdateResult> {
	const currentMtime = fileTracker.getFileMtime(filePath);

	// If we can't stat the file, skip gracefully — caller should handle removal
	if (currentMtime === null) {
		return { skipped: true, symbolCount: 0, mtime: null };
	}

	// Check whether the file has changed
	const tracked = fileTracker.getRow(filePath);
	if (tracked !== null && !fileTracker.hasFileChanged(filePath, tracked.mtime)) {
		return { skipped: true, symbolCount: 0, mtime: tracked.mtime };
	}

	// File is new or changed — re-extract symbols
	const extractor = new SymbolExtractor(parser);
	const symbols = await extractor.extractSymbols(filePath, content);

	// Write to symbol store
	symbolStore.upsertSymbols(filePath, symbols);

	// Record updated mtime
	fileTracker.recordMtime(filePath, currentMtime);

	return { skipped: false, symbolCount: symbols.length, mtime: currentMtime };
}
