/**
 * Feedback loop for tracking memory usage signals.
 * Tracks which injected memories were actually referenced by the agent.
 */

import type { ContextCache } from "./cache.ts";

export interface FeedbackResult {
	used: string[];
	ignored: string[];
	archiveCandidates: string[]; // ignoredCount > usedCount * 3
}

export class FeedbackTracker {
	private injectedThisTurn: Set<string> = new Set();
	private referencedThisTurn: Set<string> = new Set();

	recordInjection(itemIds: string[]): void {
		for (const id of itemIds) {
			this.injectedThisTurn.add(id);
		}
	}

	recordReference(itemId: string): void {
		this.referencedThisTurn.add(itemId);
	}

	endTurn(cache: ContextCache): FeedbackResult {
		const used: string[] = [];
		const ignored: string[] = [];

		for (const id of this.injectedThisTurn) {
			if (this.referencedThisTurn.has(id)) {
				used.push(id);
				cache.incrementUsedCount(id);
			} else {
				ignored.push(id);
				cache.incrementIgnoredCount(id);
			}
		}

		const archiveCandidates = cache.getArchiveCandidates().map((item) => item.id);

		this.injectedThisTurn.clear();
		this.referencedThisTurn.clear();

		return { used, ignored, archiveCandidates };
	}

	reset(): void {
		this.injectedThisTurn.clear();
		this.referencedThisTurn.clear();
	}
}

export function applyTaskSuccessSignal(cache: ContextCache, usedIds: string[], allInjectedIds: string[]): void {
	const usedSet = new Set(usedIds);
	const unusedIds = allInjectedIds.filter((id) => !usedSet.has(id));

	if (usedIds.length > 0) {
		cache.updateCognitiveWeightBatch(usedIds, 0.1);
	}
	if (unusedIds.length > 0) {
		cache.updateCognitiveWeightBatch(unusedIds, -0.02);
	}
}
