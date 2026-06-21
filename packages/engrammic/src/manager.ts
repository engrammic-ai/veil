/**
 * Context Manager - the core of Veil's context management.
 * Handles loading, eviction, and budget tracking.
 *
 * Architecture:
 *   Hot (loaded Map) → Warm (SQLite cache) → Cold (ColdStore adapter)
 *
 * Default cold storage: VeilMemoryColdStore (FSRS decay, semantic search, conflicts)
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBehavioralManifest } from "./anticipate.ts";
import { ContextCache, createItem } from "./cache.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import type { ColdStore } from "./cold/interface.ts";
import { type EmbedderStatus, VeilMemoryColdStore } from "./cold/veil-memory.ts";
import { EvictionController } from "./eviction.ts";
import { findEvictionCandidates, rankItems } from "./scorer.ts";
import type {
	ContextBudget,
	ContextItem,
	ContextManagerConfig,
	ContextWindow,
	EvictionCandidate,
	ManifestItem,
	TaskContext,
} from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { estimateTokens } from "./utils.ts";
import { RankStore } from "./worldview/graph-rank.ts";
import { getStructuralSuggestions } from "./worldview/structural-anticipate.ts";
import { StructuralFloor } from "./worldview/structural-floor.ts";
import { SymbolStore } from "./worldview/symbol-store.ts";
import type { ScoredSuggestion } from "./worldview/unified-anticipate.ts";
import { UnifiedAnticipator } from "./worldview/unified-anticipate.ts";

export class ContextManager {
	private cache: ContextCache;
	private cold: ColdStore;
	private config: ContextManagerConfig;
	private loaded: Map<string, ContextItem> = new Map();
	private budget: ContextBudget;
	private turnCount: number = 0;
	private eviction: EvictionController;
	private circuitBreaker: CircuitBreaker;
	private symbolStore?: SymbolStore;
	private rankStore?: RankStore;
	private floor: StructuralFloor;

	constructor(
		config: Partial<ContextManagerConfig> = {},
		coldStore?: ColdStore,
		symbolStore?: SymbolStore,
		rankStore?: RankStore,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };

		// Ensure db directory exists
		mkdirSync(dirname(this.config.dbPath), { recursive: true });

		this.cache = new ContextCache(this.config.dbPath);

		// Default to VeilMemory cold store (FSRS decay, semantic search)
		this.cold =
			coldStore ??
			new VeilMemoryColdStore({
				dbPath: join(dirname(this.config.dbPath), "memory.db"),
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

		// Worldview stores: use provided or create when enabled
		if (this.config.enableWorldview) {
			const db = this.cache.getDb();
			this.symbolStore = symbolStore ?? new SymbolStore(db);
			this.rankStore = rankStore ?? new RankStore(db);
		} else {
			this.symbolStore = symbolStore;
			this.rankStore = rankStore;
		}

		// Initialize structural floor for preload protection
		this.floor = new StructuralFloor(this.cache.getDb());
	}

	/**
	 * Store a new context item.
	 * Also adds to loaded set so it's visible to eviction.
	 */
	remember(
		content: string,
		type: ContextItem["type"],
		tags: string[] = [],
		toolCallId?: string,
		dedupeKey?: string,
	): ContextItem {
		const item = createItem(content, type, tags, toolCallId);
		this.cache.put(item);

		// Also add to loaded so eviction can see it
		this.loaded.set(item.id, item);

		// Track in budget (auto-captured items should count toward eviction threshold)
		this.budget.usedTokens += estimateTokens(item.content);

		if (dedupeKey) {
			this.cache.registerDedupeKey(dedupeKey, item.id);
		}

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
	 * Searches warm cache first, falls back to cold storage if empty.
	 */
	async recall(tags: string[], limit: number = 10): Promise<ContextItem[]> {
		// First check warm cache
		const warmItems = this.cache.getByTags(tags, limit * 2);
		if (warmItems.length > 0) {
			const taskCtx: TaskContext = { tags };
			const ranked = rankItems(warmItems, taskCtx, this.config);
			return ranked.slice(0, limit).map((r) => r.item);
		}

		// Fall back to cold storage
		if (this.cold?.query) {
			const query = tags.join(" ");
			const coldItems = await this.cold.query(query, tags, limit);
			return coldItems;
		}

		return [];
	}

	/**
	 * Retrieve items by semantic query with optional tag filtering.
	 * Uses cache text search, falls back to cold storage for deeper search.
	 */
	async recallByQuery(query: string, tags: string[], limit: number = 10): Promise<ContextItem[]> {
		// Search warm cache first
		const warmItems = this.cache.searchItems(query, limit * 2);
		const filtered =
			tags.length > 0 ? warmItems.filter((item) => tags.some((t) => item.tags.includes(t))) : warmItems;

		if (filtered.length >= limit) {
			const taskCtx: TaskContext = { tags };
			const ranked = rankItems(filtered, taskCtx, this.config);
			return ranked.slice(0, limit).map((r) => r.item);
		}

		// Fall back to cold storage for deeper search
		if (this.cold?.query) {
			const coldItems = await this.cold.query(query, tags, limit);
			// Merge with warm results, dedupe by ID
			const seenIds = new Set(filtered.map((i) => i.id));
			const merged = [...filtered];
			for (const item of coldItems) {
				if (!seenIds.has(item.id)) {
					merged.push(item);
					seenIds.add(item.id);
				}
			}
			return merged.slice(0, limit);
		}

		return filtered.slice(0, limit);
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
	 * Return behavioral anticipation suggestions for the given accessed items.
	 *
	 * Looks up co-access patterns for each accessed item and returns the top
	 * candidates (warm cache only) that are frequently loaded alongside them.
	 * Call this after load() to get preload candidates for the next turn.
	 *
	 * @param accessedItemIds - IDs of items that were just accessed
	 * @param limit - max suggestions to return (default 5)
	 */
	getBehavioralSuggestions(accessedItemIds: string[], limit: number = 5): ManifestItem[] {
		return buildBehavioralManifest(accessedItemIds, this.cache.coAccess, this.cache, limit);
	}

	/**
	 * Return structural preload suggestions for the given accessed file.
	 *
	 * Queries the symbol_graph for files structurally connected to `accessedFile`
	 * (imports/references in either direction) and ranks them by effective rank
	 * (pagerank * task_bias boost). Returns up to `limit` file paths.
	 *
	 * Returns an empty array when no SymbolStore or RankStore is configured,
	 * or when no connected files are found.
	 *
	 * @param accessedFile - the file that was just accessed
	 * @param limit - max suggestions to return (default 5)
	 */
	getStructuralPreloadSuggestions(accessedFile: string, limit: number = 5): string[] {
		if (!this.symbolStore || !this.rankStore) return [];
		return getStructuralSuggestions(accessedFile, this.symbolStore, this.rankStore, limit);
	}

	/**
	 * Return unified anticipatory suggestions blending structural and behavioral signals.
	 *
	 * When structural stores (SymbolStore + RankStore) are available, combines
	 * PageRank-based file graph signals with co-access behavioral patterns.
	 * Falls back to behavioral-only if structural stores are not configured.
	 *
	 * @param accessedItems - IDs/paths of items that were just accessed
	 * @param options       - optional weight overrides and result cap
	 */
	getPreloadSuggestions(
		accessedItems: string[],
		options?: { structuralWeight?: number; behavioralWeight?: number; limit?: number },
	): ScoredSuggestion[] {
		if (this.symbolStore && this.rankStore) {
			const anticipator = new UnifiedAnticipator(this.symbolStore, this.rankStore, this.cache.coAccess);
			return anticipator.getSuggestions(accessedItems, options);
		}

		// Behavioral-only fallback: wrap buildBehavioralManifest results into ScoredSuggestion shape
		const limit = options?.limit ?? 10;
		const behavioral = buildBehavioralManifest(accessedItems, this.cache.coAccess, this.cache, limit);
		return behavioral.map((item) => ({
			itemId: item.id,
			score: 0, // raw count not preserved through ManifestItem; relative ordering is preserved
			sources: ["behavioral" as const],
		}));
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
	 *
	 * @param taskCtx Current task context for scoring
	 * @param contextUsagePercent Overall context window usage (0-100). When high, triggers more aggressive eviction.
	 */
	async checkEviction(taskCtx: TaskContext, contextUsagePercent: number = 0): Promise<EvictionCandidate[]> {
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
			const wasLoaded = this.loaded.has(item.id);
			if (wasLoaded) {
				this.unload([item.id]);
			}
			await this.demoteToCold(item);
			// Only count as "evicted" if it was loaded (freeing budget)
			// Cache-only items are archival, not eviction
			if (wasLoaded) {
				evicted.push({ item, score: 0, reason: "age" });
				this.eviction.recordEviction();
			}
		}

		// Determine if we need aggressive eviction based on overall context window
		// When context is >70% full, start evicting even if internal budget is fine
		const contextPressure = contextUsagePercent > 70;

		// Stage 2: Soft evict low-score items if over threshold OR context under pressure
		const threshold = this.eviction.getThreshold();
		const shouldSoftEvict = this.budget.usedTokens > availableTokens * threshold || contextPressure;

		if (shouldSoftEvict) {
			const candidates = findEvictionCandidates(Array.from(this.loaded.values()), taskCtx, this.config);

			// Target: reduce to 60% of budget when context is under pressure
			const targetPercent = contextPressure ? 0.6 : threshold - 0.1;

			for (const { item, score } of candidates) {
				if (this.budget.usedTokens <= availableTokens * targetPercent) break;
				if (item.pinned || item.type === "intent") continue;
				if (this.eviction.isOnCooldown(item.id, currentTurn)) continue;

				this.unload([item.id]);
				await this.demoteToCold(item);
				evicted.push({ item, score, reason: contextPressure ? "context_pressure" : "low_score" });
				this.eviction.recordEviction();
			}
		}

		// Stage 3: Force evict if still over budget
		while (this.budget.usedTokens > availableTokens) {
			const items = Array.from(this.loaded.values()).filter((i) => !i.pinned && i.type !== "intent");
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

		let pointer: string | null;
		try {
			pointer = await this.circuitBreaker.execute(() => this.cold.demote(item));
		} catch (e) {
			// Circuit breaker threw - unmark to prevent stuck evicting state
			this.cache.unmarkEvicting(item.id);
			this.cache.clearEvictionForHash(item.contentHash);
			throw e;
		}

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

		// Re-request miss: only if this content was recently evicted
		const prior = this.cache.findRecentEviction(item.contentHash, this.config.reRequestWindowMs);
		if (prior) {
			this.eviction.recordReRequest();
			this.cache.clearEvictionForHash(item.contentHash);
		}

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
	 * Also records co-access for all currently-loaded items.
	 */
	tick(): boolean {
		this.turnCount++;

		// Record co-access for all items currently in the active window
		const loadedIds = Array.from(this.loaded.keys());
		if (loadedIds.length >= 2) {
			this.cache.coAccess.recordAccess(loadedIds, this.turnCount);
		}

		// Prune expired structural floors
		this.floor.pruneExpired(this.turnCount);

		const interval = this.config.decaySweepIntervalTurns;
		if (interval > 0 && this.turnCount % interval === 0) {
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
		this.cache.pruneEvictionLog(this.config.reRequestWindowMs);
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
	 * Get the symbol store (worldview structural data).
	 * Returns undefined when worldview is disabled.
	 */
	getSymbolStore(): SymbolStore | undefined {
		return this.symbolStore;
	}

	/**
	 * Get the rank store (worldview PageRank data).
	 * Returns undefined when worldview is disabled.
	 */
	getRankStore(): RankStore | undefined {
		return this.rankStore;
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
	 * Get cold storage stats including embedder status.
	 * Returns null if cold store doesn't support getStats.
	 */
	getColdStats(): {
		total: number;
		byType: { episodic: number; factual: number; procedural: number };
		conflicts: number;
		avgRetrievability: number;
		lowRCount: number;
		embedderStatus: EmbedderStatus;
		embedderError?: string;
	} | null {
		if (this.cold && "getStats" in this.cold) {
			return (this.cold as VeilMemoryColdStore).getStats();
		}
		return null;
	}

	/**
	 * Flush all warm cache items to cold storage.
	 * Call before session end to persist captured data.
	 * Clears loaded map and resets budget to prevent stale state.
	 */
	async flush(): Promise<number> {
		const items = this.cache.getAll();
		let flushed = 0;
		for (const item of items) {
			if (item.kgPointer) continue; // Already in cold
			try {
				await this.demoteToCold(item);
				flushed++;
			} catch {
				// Circuit breaker may trip; continue with remaining items
			}
		}

		// Clear loaded map and reset budget to prevent stale state after flush
		this.loaded.clear();
		this.budget.usedTokens = 0;

		return flushed;
	}

	/**
	 * Close all connections.
	 * Flushes warm cache to cold storage before closing.
	 */
	async close(): Promise<void> {
		await this.flush();
		this.cache.close();
		await this.cold.close();
	}
}
