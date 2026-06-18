/**
 * FSRS (Free Spaced Repetition Scheduler) decay engine.
 *
 * Uses power-law forgetting curve calibrated so R=0.9 when t=S.
 * Formula: R(t) = (1 + FACTOR * t/S)^DECAY
 */

import type { MemoryType } from "./types.ts";

export interface FSRSConfig {
	factor: number;
	decay: number;
	growth: number;
	diffWeight: number;
	sWeight: number;
	rWeight: number;
	minStability: number;
	maxStability: number;
	minDifficulty: number;
	maxDifficulty: number;
	initialDifficulty: number;
	initialStability: Record<MemoryType, number>;
	stabilityCap: Record<MemoryType, number>;
	tierHot: number;
	tierWarm: number;
	consolidationIntervalMs: number;
	evictionThreshold: number;
	pruneKeepPerSubject: number;
}

export const DEFAULT_FSRS_CONFIG: FSRSConfig = {
	factor: 19 / 81,
	decay: -0.5,
	growth: 1.0,
	diffWeight: 0.5,
	sWeight: 0.2,
	rWeight: 1.5,
	minStability: 0.001,
	maxStability: 365,
	minDifficulty: 0.1,
	maxDifficulty: 0.9,
	initialDifficulty: 0.5,
	initialStability: {
		episodic: 0.5,
		factual: 1,
		procedural: 7,
	},
	stabilityCap: {
		episodic: 30,
		factual: 365,
		procedural: 365,
	},
	tierHot: 0.7,
	tierWarm: 0.3,
	consolidationIntervalMs: 30 * 60 * 1000,
	evictionThreshold: 0.01,
	pruneKeepPerSubject: 10,
};

export type RetrievabilityTier = "hot" | "warm" | "cold";

export class FSRSEngine {
	private _config: FSRSConfig;

	constructor(config: Partial<FSRSConfig> = {}) {
		this._config = { ...DEFAULT_FSRS_CONFIG, ...config };
	}

	get config(): FSRSConfig {
		return this._config;
	}

	computeRetrievability(stability: number, daysSinceRecall: number): number {
		if (daysSinceRecall <= 0) return 1.0;

		const s = Math.max(this._config.minStability, stability);
		return (1 + this._config.factor * (daysSinceRecall / s)) ** this._config.decay;
	}

	updateStability(oldStability: number, difficulty: number, retrievability: number, memoryType: MemoryType): number {
		const { growth, diffWeight, sWeight, rWeight, minStability } = this._config;
		const cap = this._config.stabilityCap[memoryType];

		const sInc =
			1 +
			growth *
				(11 - difficulty * 10) ** diffWeight *
				Math.max(oldStability, minStability) ** -sWeight *
				(Math.exp((1 - retrievability) * rWeight) - 1);

		const newS = oldStability * sInc;
		return Math.min(cap, Math.max(minStability, newS));
	}

	updateDifficulty(oldDifficulty: number, wasHard: boolean): number {
		const target = wasHard ? 0.7 : 0.3;
		const newD = oldDifficulty + 0.1 * (target - oldDifficulty);
		return Math.max(this._config.minDifficulty, Math.min(this._config.maxDifficulty, newD));
	}

	getInitialStability(memoryType: MemoryType): number {
		return this._config.initialStability[memoryType];
	}

	getInitialDifficulty(): number {
		return this._config.initialDifficulty;
	}

	getTier(retrievability: number): RetrievabilityTier {
		if (retrievability > this._config.tierHot) return "hot";
		if (retrievability > this._config.tierWarm) return "warm";
		return "cold";
	}

	shouldEvict(retrievability: number): boolean {
		return retrievability < this._config.evictionThreshold;
	}

	daysSinceTimestamp(timestamp: number, now: number = Date.now()): number {
		const ms = now - timestamp;
		return ms / (1000 * 60 * 60 * 24);
	}
}
