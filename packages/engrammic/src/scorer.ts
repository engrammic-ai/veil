/**
 * Heuristic relevance scoring for context items.
 * No LLM calls - all computable from metadata.
 */

import type { ContextItem, ContextManagerConfig, TaskContext } from "./types.ts";
import type { StructuralFloor } from "./worldview/structural-floor.ts";

export interface ScorerWeights {
	recency: number;
	frequency: number;
	relevance: number;
	structural: number;
	cognitive: number;
}

export const DEFAULT_WEIGHTS: ScorerWeights = {
	recency: 0.25,
	frequency: 0.15,
	relevance: 0.3,
	structural: 0.15,
	cognitive: 0.15,
};

/**
 * Compute relevance score for a context item.
 * Higher score = more valuable = keep longer.
 *
 * @param floor   Optional structural floor tracker. When provided and the item
 *                has an active preload floor, the returned score is
 *                max(computed, floorScore), preventing premature eviction of
 *                freshly-preloaded items.
 * @param currentTurn Current turn number, required when floor is provided.
 */
export function computeRelevance(
	item: ContextItem,
	taskCtx: TaskContext,
	_config: ContextManagerConfig,
	weights: ScorerWeights = DEFAULT_WEIGHTS,
	floor?: StructuralFloor,
	currentTurn?: number,
): number {
	const now = Date.now();

	// Per-item half-life: explicit items decay slower than auto items
	const halfLifeMinutes = item.source === "explicit" ? 240 : 30;
	const halfLifeHours = halfLifeMinutes / 60;

	// Recency: exponential decay
	const ageHours = (now - item.lastAccess) / (1000 * 60 * 60);
	const recency = Math.exp(-ageHours / halfLifeHours);

	// Frequency: log scale (diminishing returns)
	const frequency = Math.log1p(item.accessCount) / Math.log(10);

	// Tag overlap: Jaccard similarity
	let relevance = 0;
	if (taskCtx.tags.length > 0 && item.tags.length > 0) {
		const taskSet = new Set(taskCtx.tags);
		const itemSet = new Set(item.tags);
		const intersection = [...taskSet].filter((t) => itemSet.has(t)).length;
		const union = new Set([...taskSet, ...itemSet]).size;
		relevance = intersection / union;
	}

	// Structural importance (has KG refs = load-bearing)
	const structural = item.kgPointer ? 1.0 : 0.5;

	// Cognitive weight from past success/failure (-1 to +1 → 0 to 1)
	const cognitive = (item.cognitiveWeight + 1) / 2;

	// Type modifier (procedural decays slower)
	const typeMod = item.type === "procedural" ? 1.2 : 1.0;

	// Pinned items get a big boost
	const pinBoost = item.pinned ? 0.5 : 0;

	const base =
		weights.recency * recency +
		weights.frequency * Math.min(1, frequency) +
		weights.relevance * relevance +
		weights.structural * structural +
		weights.cognitive * cognitive +
		pinBoost;

	// Apply decay penalty
	const withDecay = base - item.decayScore * 0.2;

	// Source modifier (explicit items score higher)
	const sourceMod = item.source === "explicit" ? 1.5 : 1.0;

	// Apply type modifier, source modifier, and clamp
	const computed = Math.min(1.0, Math.max(0.0, withDecay * typeMod * sourceMod));

	// Structural floor: if the item was preloaded, honour the minimum score
	if (floor !== undefined && currentTurn !== undefined) {
		const floorScore = floor.getFloorScore(item.id, currentTurn);
		if (floorScore > 0) {
			return Math.max(computed, floorScore);
		}
	}

	return computed;
}

/**
 * Score all items and return sorted by relevance (highest first).
 */
export function rankItems(
	items: ContextItem[],
	taskCtx: TaskContext,
	config: ContextManagerConfig,
	floor?: StructuralFloor,
	currentTurn?: number,
): Array<{ item: ContextItem; score: number }> {
	return items
		.map((item) => ({
			item,
			score: computeRelevance(item, taskCtx, config, DEFAULT_WEIGHTS, floor, currentTurn),
		}))
		.sort((a, b) => b.score - a.score);
}

/**
 * Find eviction candidates below threshold.
 */
export function findEvictionCandidates(
	items: ContextItem[],
	taskCtx: TaskContext,
	config: ContextManagerConfig,
	floor?: StructuralFloor,
	currentTurn?: number,
): Array<{ item: ContextItem; score: number }> {
	return rankItems(items, taskCtx, config, floor, currentTurn)
		.filter(({ score }) => score < config.evictionThreshold)
		.reverse(); // lowest scores first for eviction
}
