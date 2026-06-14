/**
 * EvictionController manages context eviction decisions.
 *
 * Responsibilities:
 * - Adaptive threshold: lowers when thrashing (3+ evictions in 60s), raises after stability (5+ min idle)
 * - Recall cooldowns: protect recently-recalled items from immediate eviction
 * - Item size caps: truncate oversized items to prevent budget bloat
 */

import type { ContextItem, ContextManagerConfig } from "./types.ts";
import { estimateTokens, smartTruncate } from "./utils.ts";

export interface EvictionResult {
	evicted: Array<{ item: ContextItem; score: number; reason: string }>;
}

export class EvictionController {
	private threshold: number;
	private recentEvictions: number = 0;
	private lastEvictionTime: number = 0;
	private evictionTimestamps: number[] = [];
	private cooldowns: Map<string, number> = new Map();
	private config: ContextManagerConfig;

	constructor(config: ContextManagerConfig) {
		this.config = config;
		this.threshold = config.evictionThresholdDefault;
	}

	getThreshold(): number {
		return this.threshold;
	}

	recordEviction(): void {
		const now = Date.now();
		this.lastEvictionTime = now;
		this.evictionTimestamps.push(now);

		// Keep only evictions from last 60 seconds
		const cutoff = now - 60000;
		this.evictionTimestamps = this.evictionTimestamps.filter((t) => t > cutoff);
		this.recentEvictions = this.evictionTimestamps.length;

		// If thrashing (3+ evictions in 60s), lower the threshold
		if (this.recentEvictions >= 3) {
			this.threshold = Math.max(this.config.evictionThresholdMin, this.threshold - 0.05);
		}
	}

	adjustThreshold(): void {
		const now = Date.now();
		const timeSinceLastEviction = now - this.lastEvictionTime;

		// Clean up old timestamps
		const cutoff = now - 60000;
		this.evictionTimestamps = this.evictionTimestamps.filter((t) => t > cutoff);
		this.recentEvictions = this.evictionTimestamps.length;

		// If still thrashing, lower threshold
		if (this.recentEvictions >= 3) {
			this.threshold = Math.max(this.config.evictionThresholdMin, this.threshold - 0.05);
		}
		// If stable for 5+ minutes (300000ms), raise the threshold
		// Only apply stability check if we've had at least one eviction
		else if (this.lastEvictionTime > 0 && timeSinceLastEviction > 300000) {
			this.threshold = Math.min(this.config.evictionThresholdMax, this.threshold + 0.05);
		}
	}

	setRecallCooldown(itemId: string, currentTurn: number): void {
		this.cooldowns.set(itemId, currentTurn);
	}

	isOnCooldown(itemId: string, currentTurn: number): boolean {
		const recalledAt = this.cooldowns.get(itemId);
		if (recalledAt === undefined) return false;
		return currentTurn - recalledAt < this.config.recallCooldownTurns;
	}

	clearExpiredCooldowns(currentTurn: number): void {
		for (const [itemId, recalledAt] of this.cooldowns) {
			if (currentTurn - recalledAt >= this.config.recallCooldownTurns) {
				this.cooldowns.delete(itemId);
			}
		}
	}

	enforceItemSizeCap(item: ContextItem, budgetTokens: number): ContextItem {
		const maxTokens = Math.floor(budgetTokens * this.config.maxItemBudgetRatio);
		const itemTokens = estimateTokens(item.content);

		if (itemTokens > maxTokens) {
			item.content = smartTruncate(item.content, maxTokens * 4);
			if (!item.tags.includes("truncated")) {
				item.tags.push("truncated");
			}
		}

		return item;
	}
}
