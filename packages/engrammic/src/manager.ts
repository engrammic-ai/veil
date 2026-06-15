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
import { CircuitBreaker } from "./circuit-breaker.ts";
import type { ColdStore } from "./cold/interface.ts";
import { SqliteColdStore } from "./cold/sqlite.ts";
import { EvictionController } from "./eviction.ts";
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
	private eviction: EvictionController;
	private circuitBreaker: CircuitBreaker;

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

		this.eviction = new EvictionController(this.config);
		this.circuitBreaker = new CircuitBreaker({
			failureThreshold: this.config.coldFailureThreshold,
			resetTimeout: this.config.coldCircuitResetMs,
		});

		// Recover any items stuck in evicting state
		const stuck = this.cache.recoverEvicting();
		for (const item of stuck) {
			this.cache.unmarkEvicting(item.id);
		}
	}

	/**
	 * Store a new context item.
	 */
	remember(content: string, type: ContextItem["type"], tags: string[] = [], toolCallId?: string): ContextItem {
		const item = createItem(content, type, tags, toolCallId);
		this.cache.put(item);

		// Re-request miss: this content was recently evicted and is being re-captured.
		const prior = this.cache.findRecentEviction(item.contentHash, this.config.reRequestWindowMs);
		if (prior) {
			this.eviction.recordReRequest();
			this.cache.clearEvictionForHash(item.contentHash);
		}

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

			let item = this.cache.get(id);
			if (item) {
				// Enforce per-item size cap before loading
				item = this.eviction.enforceItemSizeCap(item, this.budget.maxTokens);
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
		const currentTurn = this.turnCount;

		// Adjust adaptive threshold
		this.eviction.adjustThreshold();
		this.eviction.clearExpiredCooldowns(currentTurn);

		// Stage 1: Hard evict stale single-access items (>2h, accessed once)
		const staleMs = 2 * 60 * 60 * 1000;
		const stale = this.cache.getStale(staleMs, 1);
		for (const item of stale) {
			if (this.loaded.has(item.id)) {
				this.unload([item.id]);
				evicted.push({ item, score: 0, reason: "age" });
				this.eviction.recordEviction();
			}
			await this.demoteToCold(item);
		}

		// Stage 2: Soft evict low-score items if over threshold
		const threshold = this.eviction.getThreshold();
		if (this.budget.usedTokens > availableTokens * threshold) {
			const candidates = findEvictionCandidates(Array.from(this.loaded.values()), taskCtx, this.config);

			for (const { item, score } of candidates) {
				if (this.budget.usedTokens <= availableTokens * (threshold - 0.1)) break;
				if (item.pinned) continue;
				if (this.eviction.isOnCooldown(item.id, currentTurn)) continue;

				this.unload([item.id]);
				await this.demoteToCold(item);
				evicted.push({ item, score, reason: "low_score" });
				this.eviction.recordEviction();
			}
		}

		// Stage 3: Force evict if still over budget
		while (this.budget.usedTokens > availableTokens) {
			const items = Array.from(this.loaded.values()).filter((i) => !i.pinned);
			if (items.length === 0) break;

			const ranked = rankItems(items, taskCtx, this.config);
			const lowest = ranked[ranked.length - 1];

			this.unload([lowest.item.id]);
			await this.demoteToCold(lowest.item);
			evicted.push({ item: lowest.item, score: lowest.score, reason: "budget" });
			this.eviction.recordEviction();
		}

		return evicted;
	}

	/**
	 * Demote an item from warm cache to cold storage.
	 */
	private async demoteToCold(item: ContextItem): Promise<void> {
		this.cache.markEvicting(item.id);
		this.cache.logEviction(item.id, item.contentHash, this.turnCount);

		const pointer = await this.circuitBreaker.execute(() => this.cold.demote(item));

		if (pointer !== null) {
			item.kgPointer = pointer;
			this.cache.deleteEvicting(item.id);
		} else {
			this.cache.unmarkEvicting(item.id);
			this.cache.clearEvictionForHash(item.contentHash);
		}
	}

	/**
	 * Fetch an item from cold storage by its pointer.
	 * Automatically loads it into warm cache.
	 */
	async fetchFromCold(pointer: string): Promise<ContextItem | null> {
		const item = await this.circuitBreaker.execute(() => this.cold.fetch(pointer));
		if (!item) return null;

		// Re-request miss: we demoted this to cold and now need it back.
		this.eviction.recordReRequest();

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
			await this.circuitBreaker.execute(() => this.cold.delete(item.kgPointer!));
		}
	}

	/**
	 * Update cognitive weight based on tool success/failure.
	 * Call after each tool execution.
	 */
	recordOutcome(success: boolean): void {
		const delta = success ? 0.1 : -0.1;
		this.cache.updateCognitiveWeightBatch(Array.from(this.loaded.keys()), delta);
	}

	/**
	 * Increment turn counter and check for checkpoint.
	 */
	tick(): boolean {
		this.turnCount++;
		if (this.turnCount % this.config.decaySweepIntervalTurns === 0) {
			this.runDecaySweep();
		}
		return this.turnCount % this.config.checkpointIntervalTurns === 0;
	}

	/**
	 * Get current turn count.
	 */
	getTurnCount(): number {
		return this.turnCount;
	}

	/**
	 * Current adaptive eviction threshold (for observability / tuning tests).
	 */
	getEvictionThreshold(): number {
		return this.eviction.getThreshold();
	}

	/**
	 * Set a recall cooldown on an item to prevent immediate re-eviction.
	 */
	setRecallCooldown(itemId: string): void {
		this.eviction.setRecallCooldown(itemId, this.turnCount);
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
	 * Get the warm cache for direct access (e.g., deduplication).
	 */
	getCache(): ContextCache {
		return this.cache;
	}

	/**
	 * Get cold store capabilities.
	 */
	getColdCapabilities(): ColdStore["capabilities"] {
		return this.cold.capabilities;
	}

	/**
	 * Get the merged configuration for use by the harness.
	 */
	getConfig(): ContextManagerConfig {
		return { ...this.config };
	}

	/**
	 * Get statistics for context display.
	 */
	async getStats(): Promise<{
		warm: { episodic: number; fact: number; procedural: number };
		coldPointers: number;
	}> {
		const typeCounts = this.cache.getTypeCounts();
		const coldCount = await this.cold.count();
		return {
			warm: {
				episodic: typeCounts.episodic ?? 0,
				fact: typeCounts.fact ?? 0,
				procedural: typeCounts.procedural ?? 0,
			},
			coldPointers: coldCount,
		};
	}

	/**
	 * Link two episodes with a relation type.
	 */
	linkEpisodes(sourceId: string, targetId: string, relation: "continues" | "relates" | "supersedes"): void {
		this.cache.linkEpisodes(sourceId, targetId, relation);
	}

	/**
	 * Get episodes related to a given item.
	 */
	getRelatedEpisodes(itemId: string): Array<{ item: ContextItem; relation: string }> {
		return this.cache.getRelatedEpisodes(itemId);
	}

	/**
	 * Search cold storage for historical items matching a query.
	 */
	async searchHistory(
		query: string,
		since: number,
	): Promise<
		Array<{
			id: string;
			type: string;
			summary: string;
			sessionDate: string;
		}>
	> {
		if (!this.cold?.query) return [];

		const items = await this.cold.query(query, [], 20);
		return items
			.filter((i) => i.createdAt >= since)
			.map((i) => ({
				id: i.id,
				type: i.type,
				summary: i.content.slice(0, 50),
				sessionDate: new Date(i.createdAt).toLocaleDateString(),
			}));
	}

	/**
	 * Close all connections.
	 */
	async close(): Promise<void> {
		this.cache.close();
		await this.cold.close();
	}
}
