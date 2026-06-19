/**
 * FSRS (Free Spaced Repetition Scheduler) for context eviction.
 *
 * Uses power-law forgetting curve calibrated so R=0.9 when t=S.
 * Formula: R(t) = (1 + FACTOR * t/S)^DECAY
 *
 * Adapted from veil-memory for hot context management.
 */

import type { ContextItemType } from "./types.ts";

export interface FSRSConfig {
	factor: number;
	decay: number;
	growth: number;
	diffWeight: number;
	sWeight: number;
	rWeight: number;
	minStability: number;
	maxStability: number;
	initialStability: Record<ContextItemType, number>;
	stabilityCap: Record<ContextItemType, number>;
	evictionThreshold: number;
}

export const DEFAULT_FSRS_CONFIG: FSRSConfig = {
	factor: 19 / 81,
	decay: -0.5,
	growth: 1.0,
	diffWeight: 0.5,
	sWeight: 0.2,
	rWeight: 1.5,
	minStability: 0.001,
	maxStability: 7,
	initialStability: {
		episodic: 0.02, // ~30 min in days
		procedural: 0.25, // 6 hours
		fact: 0.083, // 2 hours
		decision: 0.5, // 12 hours
	},
	stabilityCap: {
		episodic: 1, // max 1 day for episodic
		procedural: 7, // max 7 days for procedural
		fact: 3, // max 3 days for facts
		decision: 7, // max 7 days for decisions
	},
	evictionThreshold: 0.1,
};

export class FSRSEngine {
	private config: FSRSConfig;

	constructor(config: Partial<FSRSConfig> = {}) {
		this.config = { ...DEFAULT_FSRS_CONFIG, ...config };
	}

	/**
	 * Compute retrievability (0-1) based on stability and time elapsed.
	 * Higher stability = slower decay.
	 */
	computeRetrievability(stability: number, daysSinceAccess: number): number {
		if (daysSinceAccess <= 0) return 1.0;

		const s = Math.max(this.config.minStability, stability);
		return (1 + this.config.factor * (daysSinceAccess / s)) ** this.config.decay;
	}

	/**
	 * Update stability after a successful recall (access).
	 * Items recalled when retrievability is low get a bigger stability boost.
	 */
	updateStability(
		oldStability: number,
		difficulty: number,
		retrievability: number,
		itemType: ContextItemType,
	): number {
		const { growth, diffWeight, sWeight, rWeight, minStability } = this.config;
		const cap = this.config.stabilityCap[itemType];

		const sInc =
			1 +
			growth *
				(11 - difficulty * 10) ** diffWeight *
				Math.max(oldStability, minStability) ** -sWeight *
				(Math.exp((1 - retrievability) * rWeight) - 1);

		const newS = oldStability * sInc;
		return Math.min(cap, Math.max(minStability, newS));
	}

	/**
	 * Get initial stability for an item type.
	 */
	getInitialStability(itemType: ContextItemType): number {
		return this.config.initialStability[itemType];
	}

	/**
	 * Check if item should be evicted based on retrievability.
	 */
	shouldEvict(retrievability: number): boolean {
		return retrievability < this.config.evictionThreshold;
	}

	/**
	 * Convert milliseconds to days.
	 */
	msToDays(ms: number): number {
		return ms / (1000 * 60 * 60 * 24);
	}

	/**
	 * Get days since timestamp.
	 */
	daysSince(timestamp: number, now: number = Date.now()): number {
		return this.msToDays(now - timestamp);
	}

	/**
	 * Get the eviction threshold.
	 */
	getEvictionThreshold(): number {
		return this.config.evictionThreshold;
	}
}

export const defaultFSRS = new FSRSEngine();
