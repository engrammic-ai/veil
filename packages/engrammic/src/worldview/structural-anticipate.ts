/**
 * Structural anticipatory loading.
 *
 * Given a file that was just accessed, queries the symbol_graph to find
 * structurally connected files (via import/reference edges) and ranks
 * them by effective rank (pagerank * task_bias boost).
 *
 * Used to suggest files for preloading before they are explicitly requested.
 */

import type { RankStore } from "./graph-rank.ts";
import type { SymbolStore } from "./symbol-store.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return up to `limit` file paths connected to `accessedFile` in the
 * symbol_graph, ranked by descending effective rank.
 *
 * "Connected" means:
 *   - files that `accessedFile` imports/references (outgoing edges), OR
 *   - files that import/reference `accessedFile` (incoming edges).
 *
 * Files without a rank entry are assigned an effective rank of 0 and
 * appear at the bottom of the list (still included if there is capacity).
 * The `accessedFile` itself is never returned.
 *
 * @param accessedFile - the file that was just accessed
 * @param symbolStore  - provides symbol_graph look-ups
 * @param rankStore    - provides effective rank scores
 * @param limit        - max number of suggestions (default 5)
 * @returns ordered file paths (highest effective rank first)
 */
export function getStructuralSuggestions(
	accessedFile: string,
	symbolStore: SymbolStore,
	rankStore: RankStore,
	limit: number = 5,
): string[] {
	if (limit <= 0) return [];

	const connected = findConnectedFiles(accessedFile, symbolStore);
	if (connected.size === 0) return [];

	// Rank by effective rank descending; unknown files rank as 0.
	const ranked = Array.from(connected)
		.map((file) => ({ file, rank: rankStore.getEffectiveRank(file) ?? 0 }))
		.sort((a, b) => b.rank - a.rank);

	return ranked.slice(0, limit).map((entry) => entry.file);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect the set of files structurally connected to `accessedFile`.
 *
 * Outgoing edges: files that `accessedFile` has 'ref' rows pointing to
 *   (i.e. target_file values where kind='ref').
 *
 * Incoming edges: files that contain 'ref' rows whose target_file is
 *   `accessedFile`. We discover these by looking up the symbols defined
 *   in `accessedFile` and asking the SymbolStore which files reference them.
 */
function findConnectedFiles(accessedFile: string, symbolStore: SymbolStore): Set<string> {
	const connected = new Set<string>();

	// --- Outgoing: files that accessedFile imports ---
	const rows = symbolStore.getSymbolsForFile(accessedFile);
	for (const row of rows) {
		if (row.kind === "ref" && row.target_file !== null && row.target_file !== accessedFile) {
			connected.add(row.target_file);
		}
	}

	// --- Incoming: files that import accessedFile ---
	// Find symbols defined in accessedFile, then find who references them.
	const definedSymbols = rows.filter((r) => r.kind === "def").map((r) => r.symbol);
	for (const symbol of definedSymbols) {
		const refs = symbolStore.getReferencesTo(symbol);
		for (const ref of refs) {
			if (ref.file !== accessedFile) {
				connected.add(ref.file);
			}
		}
	}

	return connected;
}
