/**
 * @engrammic/veil
 * Context management for Veil - dynamic loading, heuristic eviction, episodic memory
 */

export { ContextManager } from './manager.js'
export { ContextCache, createItem, hashContent } from './cache.js'
export { computeRelevance, rankItems, findEvictionCandidates } from './scorer.js'
export type { ScorerWeights } from './scorer.js'
export {
	DEFAULT_CONFIG,
	type ContextItem,
	type TaskContext,
	type ContextBudget,
	type ContextWindow,
	type ContextManagerConfig,
	type EvictionCandidate,
} from './types.js'
