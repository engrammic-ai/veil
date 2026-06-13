/**
 * Context Manager - the core of Veil's context management.
 * Handles loading, eviction, and budget tracking.
 *
 * Architecture:
 *   Hot (loaded Map) → Warm (SQLite cache) → Cold (ColdStore adapter)
 *
 * Default cold storage: SqliteColdStore (zero config)
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContextCache, createItem } from "./cache.ts";
import type { ColdStore } from "./cold/interface.ts";
import { SqliteColdStore } from "./cold/sqlite.ts";
import { findEvictionCandidates, rankItems } from "./scorer.ts";
import type {
	ContextBudget,
	ContextItem,
	ContextManagerConfig,
	ContextWindow,
	EvictionCandidate,
	TaskContext,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { estimateTokens } from "./utils.ts";

export class ContextManager {
	private cache: ContextCache;
	private cold: ColdStore;
	private config: ContextManagerConfig;
	private loaded: Map<string, ContextItem> = new Map();
	private budget: ContextBudget;
	private turnCount: number = 0;

	constructor(config: Partial<ContextManagerConfig> = {}, coldStore?: ColdStore) {
		this.config = { ...DEFAULT_CONFIG, ...config };

		// Ensure db directory exists
		mkdirSync(dirname(this.config.dbPath), { recursive: true });

		this.cache = new ContextCache(this.config.dbPath);

		// Default to SQLite cold store in same directory
		this.cold =
			coldStore ??
			new SqliteColdStore({
				dbPath: join(dirname(this.config.dbPath), "cold.db"),
			});

		this.budget = {
			maxTokens: this.config.maxTokens,
			usedTokens: 0,
			reserveTokens: this.config.reserveTokens,
		};
	}

	/**
	 * Store a new context item.
	 */
	remember(content: string, type: ContextItem["type"], tags: string[] = []): ContextItem {
		const item = createItem(content, type, tags);
		this.cache.put(item);
		return item;
	}

	/**
	 * Retrieve relevant items by tags.
	 */
	recall(tags: string[], limit: number = 10): ContextItem[] {
		const items = this.cache.getByTags(tags, limit * 2); // fetch more, then rank
		const taskCtx: TaskContext = { tags };
		const ranked = rankItems(items, taskCtx, this.config);
		return ranked.slice(0, limit).map((r) => r.item);
	}

	/**
	 * Load items into active context window.
	 */
	load(ids: string[]): ContextItem[] {
		const items: ContextItem[] = [];

		for (const id of ids) {
			if (this.loaded.has(id)) {
				items.push(this.loaded.get(id)!);
				continue;
			}

			const item = this.cache.get(id);
			if (item) {
				this.cache.touch(id);
				this.loaded.set(id, item);
				this.budget.usedTokens += estimateTokens(item.content);
				items.push(item);
			}
		}

		return items;
	}

	/**
	 * Unload items from active context window.
	 */
	unload(ids: string[]): void {
		for (const id of ids) {
			const item = this.loaded.get(id);
			if (item) {
				this.budget.usedTokens -= estimateTokens(item.content);
				this.loaded.delete(id);
			}
		}
	}

	/**
	 * Get current context window state.
	 */
	getWindow(): ContextWindow {
		return {
			items: Array.from(this.loaded.values()),
			budget: { ...this.budget },
		};
	}

	/**
	 * Check if eviction is needed and run if so.
	 * Call this before each LLM call.
	 *
	 * Items are demoted to cold storage, not deleted.
	 */
	async checkEviction(taskCtx: TaskContext): Promise<EvictionCandidate[]> {
		const availableTokens = this.budget.maxTokens - this.budget.reserveTokens;
		const evicted: EvictionCandidate[] = [];

		// Stage 1: Hard evict stale single-access items (>2h, accessed once)
		const staleMs = 2 * 60 * 60 * 1000; // 2 hours
		const stale = this.cache.getStale(staleMs, 1);
		for (const item of stale) {
			if (this.loaded.has(item.id)) {
				this.unload([item.id]);
				evicted.push({ item, score: 0, reason: "age" });
			}
			// Demote to cold storage instead of deleting
			await this.demoteToCold(item);
		}

		// Stage 2: Soft evict low-score items if over budget
		if (this.budget.usedTokens > availableTokens * 0.7) {
			const candidates = findEvictionCandidates(Array.from(this.loaded.values()), taskCtx, this.config);

			for (const { item, score } of candidates) {
				if (this.budget.usedTokens <= availableTokens * 0.6) break;
				if (item.pinned) continue;

				this.unload([item.id]);
				evicted.push({ item, score, reason: "low_score" });
			}
		}

		// Stage 3: Force evict if still over budget
		while (this.budget.usedTokens > availableTokens) {
			const items = Array.from(this.loaded.values()).filter((i) => !i.pinned);
			if (items.length === 0) break;

			const ranked = rankItems(items, taskCtx, this.config);
			const lowest = ranked[ranked.length - 1];

			this.unload([lowest.item.id]);
			evicted.push({ item: lowest.item, score: lowest.score, reason: "budget" });
		}

		return evicted;
	}

	/**
	 * Demote an item from warm cache to cold storage.
	 */
	private async demoteToCold(item: ContextItem): Promise<void> {
		const pointer = await this.cold.demote(item);
		item.kgPointer = pointer;
		this.cache.delete(item.id);
	}

	/**
	 * Fetch an item from cold storage by its pointer.
	 * Automatically loads it into warm cache.
	 */
	async fetchFromCold(pointer: string): Promise<ContextItem | null> {
		const item = await this.cold.fetch(pointer);
		if (!item) return null;

		// Bring back to warm cache
		this.cache.put(item);
		return item;
	}

	/**
	 * Pin/unpin an item to prevent eviction.
	 */
	pin(id: string): void {
		const item = this.loaded.get(id) ?? this.cache.get(id);
		if (item) {
			item.pinned = true;
			this.cache.put(item);
			if (this.loaded.has(id)) {
				this.loaded.set(id, item);
			}
		}
	}

	unpin(id: string): void {
		const item = this.loaded.get(id) ?? this.cache.get(id);
		if (item) {
			item.pinned = false;
			this.cache.put(item);
			if (this.loaded.has(id)) {
				this.loaded.set(id, item);
			}
		}
	}

	/**
	 * Explicitly forget an item (from all tiers).
	 */
	async forget(id: string): Promise<void> {
		const item = this.loaded.get(id) ?? this.cache.get(id);
		this.unload([id]);
		this.cache.delete(id);

		// Also delete from cold if it was demoted
		if (item?.kgPointer) {
			await this.cold.delete(item.kgPointer);
		}
	}

	/**
	 * Update cognitive weight based on tool success/failure.
	 * Call after each tool execution.
	 */
	recordOutcome(success: boolean): void {
		const delta = success ? 0.1 : -0.1;
		for (const id of this.loaded.keys()) {
			this.cache.updateCognitiveWeight(id, delta);
		}
	}

	/**
	 * Increment turn counter and check for checkpoint.
	 */
	tick(): boolean {
		this.turnCount++;
		return this.turnCount % this.config.checkpointIntervalTurns === 0;
	}

	/**
	 * Get current turn count.
	 */
	getTurnCount(): number {
		return this.turnCount;
	}

	/**
	 * Run decay sweep (call periodically, e.g., daily).
	 */
	runDecaySweep(): string[] {
		this.cache.applyDecay(0.95);
		return this.cache.pruneByDecay(0.9);
	}

	/**
	 * Get budget status.
	 */
	getBudget(): ContextBudget {
		return { ...this.budget };
	}

	/**
	 * Get cold store capabilities.
	 */
	getColdCapabilities(): ColdStore["capabilities"] {
		return this.cold.capabilities;
	}

	/**
	 * Close all connections.
	 */
	async close(): Promise<void> {
		this.cache.close();
		await this.cold.close();
	}
}
