/**
 * @engrammic/veil
 * Context management for Veil - dynamic loading, heuristic eviction, episodic memory
 */

export { ContextCache, createItem, hashContent } from "./cache.ts";
export { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";
export { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.ts";
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
export { type ContextCommandOutput, renderContextCommand } from "./commands/context.ts";
export { EvictionController, type EvictionResult } from "./eviction.ts";
export {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type ToolResultEvent,
	VeilHarness,
	type VeilHarnessConfig,
} from "./harness.ts";
export {
	detectStubs,
	formatHydratedBlock,
	type HydrationResult,
	hydrateStub,
	type ParsedStub,
	parseStub,
	STUB_PATTERN,
} from "./hydration.ts";
export { buildContextSection, type ContextSectionItem, type ContextSectionOptions, formatStub } from "./injection.ts";
// Core
export { ContextManager } from "./manager.ts";
export { buildCheckpointPrompt, type CheckpointPromptOptions, CONTEXT_MANAGEMENT_PROMPT } from "./prompts.ts";
export type { ScorerWeights } from "./scorer.ts";
export { computeRelevance, findEvictionCandidates, rankItems } from "./scorer.ts";
export { executeVeilTool, TOOL_SCHEMAS, type ToolContext, type ToolDefinition, type ToolResult } from "./tools.ts";
export {
	type CaptureRule,
	type ContextBudget,
	type ContextItem,
	type ContextManagerConfig,
	type ContextWindow,
	DEFAULT_CAPTURE_CONFIG,
	DEFAULT_CONFIG,
	DEFAULT_EVICTION_NOTIFY_CONFIG,
	type EvictionCandidate,
	type EvictionNotifyConfig,
	type TaskContext,
} from "./types.ts";
export { estimateTokens, formatTokens, smartTruncate } from "./utils.ts";
export {
	formatBox,
	formatEvictionNotification,
	formatProgressBar,
	formatStatusBar,
	getHealthColor,
	type HealthColor,
	type StatusBarResult,
} from "./ux.ts";
