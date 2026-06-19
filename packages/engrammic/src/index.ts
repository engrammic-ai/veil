/**
 * @engrammic/veil
 * Context management for Veil - dynamic loading, heuristic eviction, episodic memory
 */

export { buildManifest, DEFAULT_TRIGGERS, formatManifest, matchTriggers } from "./anticipate.ts";
// Phase D: Failure-memory
export {
	type AttemptDetection,
	type AttemptOutcome,
	type AttemptRecord,
	AttemptStore,
	detectFailure,
	extractFailedTestNames,
	normalizeError,
} from "./attempts.ts";
export { ContextCache, createItem, hashContent } from "./cache.ts";
export { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";
export {
	type CaptureDocument,
	type CaptureLink,
	type CaptureType,
	normalizeCapture,
} from "./capture-document.ts";
export { type CatConfig, type CatState, CatWidget, DEFAULT_CAT_CONFIG, type SessionStats } from "./cat.ts";
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
// Compression pipeline
export {
	type CodeCompressOptions,
	type CompressionResult,
	type CompressOptions,
	type ConfigCompressOptions,
	type ContentMetadata,
	type ContentType,
	type ConversationCompressOptions,
	compress,
	compressCode,
	compressConfig,
	compressConversation,
	compressSync,
	detectContentType,
} from "./compression/index.ts";
// Phase D: Convergence monitor
export {
	buildConvergenceWarning,
	ConvergenceMonitor,
	type ConvergenceState,
	type ConvergenceThresholds,
	DEFAULT_THRESHOLDS,
	type EscalationLevel,
	type EscalationResult,
	isProgress,
} from "./convergence.ts";
export { EvictionController, type EvictionResult } from "./eviction.ts";
export { createVeilExtension } from "./extension.ts";
export { DEFAULT_FSRS_CONFIG, defaultFSRS, type FSRSConfig, FSRSEngine } from "./fsrs.ts";
export {
	advanceGoalState,
	createGoalInferenceState,
	DEFAULT_LLM_CONFIG,
	detectRetryMarker,
	extractRationale,
	extractTarget,
	extractTestSuite,
	type GoalInferenceLLMConfig,
	type GoalInferenceState,
	inferGoalId,
	inferGoalWithLLM,
	isTestRunner,
	normalizeCommand,
	normalizeFilePath,
	RETRY_MARKERS,
	shouldCloseGoal,
	shouldMergeGoals,
} from "./goal-inference.ts";
export {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type MemoryEvent,
	type MemoryEventType,
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
export {
	buildContextSection,
	buildFailureSection,
	type ContextSectionItem,
	type ContextSectionOptions,
	type FailureSectionOptions,
	formatStub,
	formatTurnAge,
} from "./injection.ts";
// Core
export { ContextManager } from "./manager.ts";
export { type ExportOptions, type ExportResult, exportBundle } from "./okf-bundle.ts";
export { buildCheckpointPrompt, type CheckpointPromptOptions, CONTEXT_MANAGEMENT_PROMPT } from "./prompts.ts";
export {
	computeRelevanceScore,
	formatSelectedContext,
	type SelectionResult,
	selectForTurn,
	type TurnContext,
} from "./retrieval.ts";
export type { ScorerWeights } from "./scorer.ts";
export { computeRelevance, findEvictionCandidates, rankItems } from "./scorer.ts";
export { executeVeilTool, TOOL_SCHEMAS, type ToolContext, type ToolDefinition, type ToolResult } from "./tools.ts";
export {
	handleTrigger,
	isDangerousCommand,
	type TriggerContext,
	type TriggerResult,
	type TriggerType,
} from "./triggers.ts";
export {
	type CaptureRule,
	type ContextBudget,
	type ContextItem,
	type ContextItemType,
	type ContextManagerConfig,
	type ContextManifest,
	type ContextWindow,
	DEFAULT_CAPTURE_CONFIG,
	DEFAULT_CONFIG,
	DEFAULT_EVICTION_NOTIFY_CONFIG,
	type EvictionCandidate,
	type EvictionNotifyConfig,
	type ManifestItem,
	type TaskContext,
	type Trigger,
} from "./types.ts";
export { type ExportOptions, type ExportResult, exportBundle } from "./okf-bundle.ts";
export { estimateTokens, formatRelativeTime, formatTokens, smartTruncate } from "./utils.ts";
export {
	formatBox,
	formatEvictionNotification,
	formatProgressBar,
	formatStatusBar,
	getHealthColor,
	type HealthColor,
	type StatusBarResult,
} from "./ux.ts";
