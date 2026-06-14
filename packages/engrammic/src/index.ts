/**
 * @engrammic/veil
 * Context management for Veil - dynamic loading, heuristic eviction, episodic memory
 */

export { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.ts";
export { ContextCache, createItem, hashContent } from "./cache.ts";
export { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";
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
export {
	VeilHarness,
	type VeilHarnessConfig,
	type BeforeToolCallContext,
	type AfterToolCallContext,
	type BeforeToolCallResult,
	type AfterToolCallResult,
	type ToolResultEvent,
} from "./harness.ts";
// Core
export { ContextManager } from "./manager.ts";
export { buildCheckpointPrompt, type CheckpointPromptOptions, CONTEXT_MANAGEMENT_PROMPT } from "./prompts.ts";
export type { ScorerWeights } from "./scorer.ts";
export { computeRelevance, findEvictionCandidates, rankItems } from "./scorer.ts";
export {
	type CaptureRule,
	type ContextBudget,
	type ContextItem,
	type ContextManagerConfig,
	type ContextWindow,
	DEFAULT_CONFIG,
	DEFAULT_CAPTURE_CONFIG,
	type EvictionCandidate,
	type TaskContext,
} from "./types.ts";
export { estimateTokens, formatTokens, smartTruncate } from "./utils.ts";
export { buildContextSection, formatStub, type ContextSectionItem, type ContextSectionOptions } from "./injection.ts";
export { detectStubs, hydrateStub, parseStub, formatHydratedBlock, type ParsedStub, type HydrationResult, STUB_PATTERN } from "./hydration.ts";
export { TOOL_SCHEMAS, executeVeilTool, type ToolDefinition, type ToolResult, type ToolContext } from "./tools.ts";
export { renderContextCommand, type ContextCommandOutput } from "./commands/context.ts";
