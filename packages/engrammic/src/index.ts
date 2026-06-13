/**
 * @engrammic/veil
 * Context management for Veil - dynamic loading, heuristic eviction, episodic memory
 */

export { ContextCache, createItem, hashContent } from "./cache.ts";
// Cold storage adapters
export {
	ChromaColdStore,
	type ChromaColdStoreConfig,
	// Interface
	type ColdStore,
	type ColdStoreCapabilities,
	type ColdStoreConfig,
	LanceDBColdStore,
	type LanceDBColdStoreConfig,
	MemoryColdStore,
	// Adapters (no external deps)
	SqliteColdStore,
	type SqliteColdStoreConfig,
	// Adapters (peer deps required)
	ZepColdStore,
	type ZepColdStoreConfig,
} from "./cold/index.ts";
export { VeilHarness, type VeilHarnessConfig } from "./harness.ts";
// Core
export { ContextManager } from "./manager.ts";
export type { ScorerWeights } from "./scorer.ts";
export { computeRelevance, findEvictionCandidates, rankItems } from "./scorer.ts";
export {
	type ContextBudget,
	type ContextItem,
	type ContextManagerConfig,
	type ContextWindow,
	DEFAULT_CONFIG,
	type EvictionCandidate,
	type TaskContext,
} from "./types.ts";
export { contentHash, estimateTokens, smartTruncate } from "./utils.ts";
