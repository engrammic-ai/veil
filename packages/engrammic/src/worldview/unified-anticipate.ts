/**
 * Unified anticipatory loading.
 *
 * Merges structural (PageRank-based) and behavioral (co-access) signals
 * into a single ranked suggestion list for anticipatory preloading.
 *
 * Structural signal: files connected via code graph, ranked by effective rank.
 * Behavioral signal: files frequently accessed together with the current set.
 *
 * Final score = structuralWeight * normalizedStructuralScore
 *             + behavioralWeight * normalizedBehavioralScore
 *
 * Both weights default to 0.6 / 0.4 and are configurable per call.
 */

import type { CoAccessTracker } from "./co-access.ts";
import type { RankStore } from "./graph-rank.ts";
import type { SymbolStore } from "./symbol-store.ts";
import { getStructuralSuggestions } from "./structural-anticipate.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScoredSuggestion {
	itemId: string;
	score: number;
	sources: ("structural" | "behavioral")[];
}

export interface UnifiedAnticipatorOptions {
	structuralWeight?: number;
	behavioralWeight?: number;
	limit?: number;
}

// ---------------------------------------------------------------------------
// UnifiedAnticipator
// ---------------------------------------------------------------------------

export class UnifiedAnticipator {
	private symbolStore: SymbolStore;
	private rankStore: RankStore;
	private coAccessTracker: CoAccessTracker;

	constructor(symbolStore: SymbolStore, rankStore: RankStore, coAccessTracker: CoAccessTracker) {
		this.symbolStore = symbolStore;
		this.rankStore = rankStore;
		this.coAccessTracker = coAccessTracker;
	}

	/**
	 * Return up to `limit` suggestions, blending structural and behavioral signals.
	 *
	 * @param accessedItems - IDs/paths of items just accessed
	 * @param options       - weight overrides and result cap
	 */
	getSuggestions(accessedItems: string[], options?: UnifiedAnticipatorOptions): ScoredSuggestion[] {
		const structuralWeight = options?.structuralWeight ?? 0.6;
		const behavioralWeight = options?.behavioralWeight ?? 0.4;
		const limit = options?.limit ?? 10;

		if (accessedItems.length === 0 || limit <= 0) return [];

		// Collect structural candidates with raw effective-rank scores
		const structuralRaw = new Map<string, number>();
		for (const item of accessedItems) {
			const suggestions = getStructuralSuggestions(
				item,
				this.symbolStore,
				this.rankStore,
				limit * 3, // oversample to allow blending
			);
			for (const file of suggestions) {
				const rank = this.rankStore.getEffectiveRank(file) ?? 0;
				structuralRaw.set(file, Math.max(structuralRaw.get(file) ?? 0, rank));
			}
		}

		// Collect behavioral candidates with raw co-access counts
		const accessedSet = new Set(accessedItems);
		const behavioralRaw = new Map<string, number>();
		for (const item of accessedItems) {
			const coAccessed = this.coAccessTracker.getCoAccessedWith(item, limit * 3);
			for (const entry of coAccessed) {
				if (accessedSet.has(entry.itemId)) continue; // skip already-accessed items
				behavioralRaw.set(entry.itemId, (behavioralRaw.get(entry.itemId) ?? 0) + entry.count);
			}
		}

		// Normalize each signal to [0, 1]
		const structuralNorm = normalizeMap(structuralRaw);
		const behavioralNorm = normalizeMap(behavioralRaw);

		// Union all candidate keys
		const allCandidates = new Set([...structuralNorm.keys(), ...behavioralNorm.keys()]);

		// Blend scores
		const results: ScoredSuggestion[] = [];
		for (const candidate of allCandidates) {
			if (accessedSet.has(candidate)) continue; // never re-surface what's already loaded

			const sScore = structuralNorm.get(candidate) ?? 0;
			const bScore = behavioralNorm.get(candidate) ?? 0;
			const finalScore = structuralWeight * sScore + behavioralWeight * bScore;

			const sources: ("structural" | "behavioral")[] = [];
			if (sScore > 0) sources.push("structural");
			if (bScore > 0) sources.push("behavioral");

			results.push({ itemId: candidate, score: finalScore, sources });
		}

		// Sort by blended score descending, cap at limit
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a map of raw scores to the [0, 1] range.
 * Returns a new map. Input map is not mutated.
 */
function normalizeMap(raw: Map<string, number>): Map<string, number> {
	if (raw.size === 0) return new Map();

	const max = Math.max(...raw.values());
	if (max === 0) {
		// All zeros — return uniform 0 scores
		return new Map(Array.from(raw.keys()).map((k) => [k, 0]));
	}

	const normalized = new Map<string, number>();
	for (const [key, value] of raw) {
		normalized.set(key, value / max);
	}
	return normalized;
}
