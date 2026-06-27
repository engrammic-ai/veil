/**
 * Veil Harness - integrates ContextManager with Pi's agent loop.
 *
 * Usage:
 *   const harness = new VeilHarness({ dbPath: '.veil/context.db' })
 *   const config: AgentLoopConfig = {
 *     ...baseConfig,
 *     ...harness.getHooks(),
 *   }
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, DEFAULT_TRIGGERS, formatManifest, matchTriggers } from "./anticipate.ts";
import { type AttemptRecord, AttemptStore, detectFailure } from "./attempts.ts";
import { hashContent } from "./cache.ts";
import { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";
import { normalizeCapture } from "./capture-document.ts";
import { type CatConfig, CatWidget, type SessionStats } from "./cat.ts";
import { EngrammicColdStore } from "./cold/engrammic.ts";
import type { McpExecutor } from "./cold/engrammic-mock.ts";
import type { ColdStore } from "./cold/interface.ts";
import { VeilMemoryColdStore } from "./cold/veil-memory.ts";
import { type ContentMetadata, compressSync } from "./compression/index.ts";
import {
	buildConvergenceWarning,
	ConvergenceMonitor,
	type ConvergenceState,
	type ConvergenceThresholds,
	type EscalationResult,
} from "./convergence.ts";
import { type ArchivedTurn, ConversationArchive } from "./conversation-archive.ts";
import { createEvictionFeedbackTracker, detectRerequest, type EvictionFeedbackTracker } from "./eviction-feedback.ts";
import { getExtractor } from "./extractors/index.ts";
import type { EnhancedCaptureRule, ExtractorResult } from "./extractors/types.ts";
import { applyTaskSuccessSignal, type FeedbackResult, FeedbackTracker } from "./feedback.ts";
import {
	advanceGoalState,
	createGoalInferenceState,
	extractTarget,
	type GoalInferenceState,
	inferGoalId,
} from "./goal-inference.ts";
import { detectStubs, formatHydratedBlock, hydrateStub } from "./hydration.ts";
import { buildContextSection, buildFailureSection, formatStub } from "./injection.ts";
import { IpcClient } from "./ipc-client.ts";
import { analyzePatterns, patternToTrigger } from "./learning.ts";
import { ContextManager } from "./manager.ts";
import { buildCheckpointPrompt, CONTEXT_MANAGEMENT_PROMPT } from "./prompts.ts";
import { computeReferencePenalty } from "./reference-detector.ts";
import { type SelectionResult, selectForTurn, type TurnContext } from "./retrieval.ts";
import { rankItems } from "./scorer.ts";
import Database from "./sqlite.ts";
import { executeVeilTool, TOOL_SCHEMAS, type ToolDefinition, type ToolResult } from "./tools.ts";
import { handleTrigger, isDangerousCommand, type TriggerResult } from "./triggers.ts";
import { classifyTurn, stripTurnMeta } from "./turn-classifier.ts";
import { rankForEviction, selectForEviction } from "./turn-eviction.ts";
import { generateStub } from "./turn-stub.ts";
import type {
	CaptureConfig,
	ContextItem,
	ContextManagerConfig,
	ContextManifest,
	EvictionCandidate,
	PendingConflict,
	TaskContext,
	Trigger,
} from "./types.ts";
import { DEFAULT_CAPTURE_CONFIG } from "./types.ts";
import { estimateTokens, smartTruncate } from "./utils.ts";

export interface SearchResult {
	id: string;
	tier: "hot" | "warm" | "cold";
	type: ContextItem["type"];
	summary: string; // first 40 chars of content
	tokens: number;
	score: number; // 1.0 for hot, 0.8 for warm
	tags: string[];
}

export interface LearningConfig {
	/** How often to run pattern learning (ms). Default: 1 hour. */
	intervalMs: number;
	/** Minimum hydration events before learning runs. Default: 10. */
	minHydrations: number;
}

export type MemoryEventType =
	| "watching"
	| "remembering"
	| "learned"
	| "recalled"
	| "forgetting"
	| "conflict"
	| "sleeping"
	| "budget_exceeded"
	| "budget_warning"
	| "context_update"
	| "eviction"
	| "checkpoint";

export interface MemoryEvent {
	type: MemoryEventType;
	detail?: string;
	/** Current context usage stats, included with budget-related events */
	usage?: {
		/** Overall context window usage (0-100) as reported by agent-session */
		contextPercent: number;
		/** Harness hot tier tokens */
		hotTokens: number;
		hotItems: number;
		/** Harness budget */
		budgetMax: number;
		budgetUsed: number;
	};
	/** Eviction details, included with eviction events */
	eviction?: {
		evictedIds: string[];
		tokensFreed: number;
		turn: number;
	};
	/** Checkpoint details, included with checkpoint events */
	checkpoint?: {
		turn: number;
		hotCount: number;
		warmCount: number;
		budgetPercent: number;
	};
}

export interface VeilHarnessConfig extends Partial<ContextManagerConfig> {
	coldStore?: ColdStore;
	onEviction?: (evicted: EvictionCandidate[]) => void;
	onCheckpoint?: (turnCount: number) => void;
	onMemoryEvent?: (event: MemoryEvent) => void;
	sessionId?: string; // Tag context items with session
	captureConfig?: Partial<CaptureConfig>;
	learningConfig?: Partial<LearningConfig>;
	catConfig?: Partial<CatConfig>;
	// Phase D.3: Convergence callbacks
	convergenceThresholds?: Partial<ConvergenceThresholds>;
	onConvergenceWarning?: (state: ConvergenceState, result: EscalationResult) => void;
	onConvergenceHalt?: (state: ConvergenceState, result: EscalationResult) => void;
	// Subagent child mode options
	parentDbPath?: string; // Parent's warm cache DB path (presence indicates child mode)
	parentSessionId?: string; // Parent session ID for provenance tracking
	tagPrefix?: string; // Memory namespace prefix, e.g. "scout"
	ipcPath?: string; // IPC socket path for parent-child communication
	enableVeilTools?: boolean; // Whether to enable veil_* tools (default: true)
	archivePath?: string; // Path to conversation archive DB (enables turn archiving when provided)
	// Cold backend selection
	coldBackend?: "local" | "engrammic"; // default: "local"
	engrammic?: {
		mcpServerName?: string;
		siloId?: string;
		tagWithProject?: boolean;
		defaultDecay?: "ephemeral" | "standard" | "durable" | "permanent";
		/** Fall back to local cold store if engrammic is unreachable. Default: false. */
		fallbackToLocal?: boolean;
		enableCache?: boolean;
		cacheTtlSeconds?: number;
	};
	mcpExecutor?: McpExecutor;
}

export interface ImportOptions {
	/** Tag prefix for imported items (default: from child context) */
	tag?: string;
	/** Transfer cognitive weights from child (default: true) */
	transferWeights?: boolean;
	/** Child session ID for provenance */
	sessionId?: string;
}

export interface ImportResult {
	/** Number of items imported */
	imported: number;
	/** Number of items skipped (duplicates) */
	skipped: number;
}

export interface ForkOptions {
	/** Context propagation mode */
	mode: "fork" | "fresh" | "share";
	/** Tag prefix for child captures (e.g., "scout", "researcher") */
	tagPrefix: string;
	/** Maximum warm items to inherit from parent (default: 100) */
	maxWarmInherit?: number;
}

export interface ForkResult {
	/** The forked child harness */
	harness: VeilHarness;
	/** Path to child's database */
	dbPath: string;
	/** Child session ID */
	sessionId: string;
}

export interface MergeOptions {
	/** Minimum score for items to import (default: 0) */
	minScore?: number;
	/** Only import items matching these tags */
	tags?: string[];
	/** Maximum items to import (default: 50) */
	maxItems?: number;
	/** How to handle conflicts: keep-parent, keep-child, keep-both (default: keep-parent) */
	onConflict?: "keep-parent" | "keep-child" | "keep-both";
	/** Preserve provenance chain (default: true) */
	preserveProvenance?: boolean;
	/** Transfer cognitive weights from child (default: true) */
	transferWeights?: boolean;
}

export interface MergeResult {
	/** Number of items imported */
	imported: number;
	/** Number of items skipped (duplicates or filtered) */
	skipped: number;
	/** Child session ID */
	childSession: string;
}

export interface BeforeToolCallContext {
	toolCall: { name: string };
	args: unknown;
}

export interface AfterToolCallContext {
	toolCall: { name: string };
	result: { isError?: boolean };
}

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface AfterToolCallResult {
	terminate?: boolean;
}

export interface ToolResultEvent {
	toolName: string;
	toolCallId?: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
}

export interface UsageStats {
	hotTokens: number;
	hotItems: number;
	budgetMax: number;
	budgetUsed: number;
	budgetReserve: number;
	percent: number;
}

interface ManifestContext {
	itemIds: Set<string>;
	triggerIds: string[];
	userMessage: string;
	timestamp: number;
}

/** Remove child DBs older than maxAgeMs from a parent DB's .children directory. */
function cleanupOrphanedChildDbs(parentDbPath: string, maxAgeMs = 24 * 60 * 60 * 1000): number {
	const childrenDir = `${parentDbPath}.children`;
	if (!existsSync(childrenDir)) return 0;
	let removed = 0;
	const now = Date.now();
	for (const file of readdirSync(childrenDir)) {
		if (!file.endsWith(".db")) continue;
		const filePath = join(childrenDir, file);
		try {
			const stat = statSync(filePath);
			if (now - stat.mtimeMs > maxAgeMs) {
				rmSync(filePath, { force: true });
				rmSync(`${filePath}-shm`, { force: true });
				rmSync(`${filePath}-wal`, { force: true });
				removed++;
			}
		} catch {
			// Ignore errors for individual files
		}
	}
	return removed;
}

export class VeilHarness {
	private manager: ContextManager;
	private config: VeilHarnessConfig;
	private currentTaskContext: TaskContext = { tags: [] };
	private sessionId: string | undefined;
	private unsubscribe?: () => void;
	private captureConfig: CaptureConfig;
	private capturesThisTurn: number = 0;
	private totalCaptures: number = 0;
	private evictedToolCallIds: Set<string> = new Set();
	private triggers: Trigger[] = DEFAULT_TRIGGERS;
	private currentManifest: ManifestContext | null = null;
	private readonly learningConfig: LearningConfig = {
		intervalMs: 60 * 60 * 1000, // 1 hour default
		minHydrations: 10,
	};
	private lastLearnTime: number = 0;
	private memoryEventListeners: Array<(event: MemoryEvent) => void> = [];
	private tokenBudget = { used: 0, softWarningEmitted: false };

	// Overall context window usage (0-100%), updated by agent-session
	private contextUsagePercent: number = 0;

	// Cat widget
	private catWidget: CatWidget;
	private catEnabled: boolean = true;
	private sessionStats: SessionStats = {
		remembered: 0,
		learned: 0,
		recalled: 0,
		stabilityAvg: 0,
		conflicts: 0,
		evicted: 0,
	};

	// Phase D: Failure-memory
	private attemptStore: AttemptStore;
	private convergenceMonitor: ConvergenceMonitor;
	private goalState: GoalInferenceState;

	// Feedback loop
	private feedbackTracker: FeedbackTracker = new FeedbackTracker();

	// Conversation eviction
	private conversationArchive?: ConversationArchive;
	private turnCounter: number = 0;
	private evictionFeedbackTracker: EvictionFeedbackTracker = createEvictionFeedbackTracker();
	private evictionStubs: string[] = [];

	private pendingCaptures: Map<
		string,
		{
			timer: NodeJS.Timeout;
			rule: EnhancedCaptureRule;
			latestExtracted: ExtractorResult;
			count: number;
			toolName: string;
			args: unknown;
			toolCallId?: string;
		}
	> = new Map();
	private autoCapturedIds: Set<string> = new Set();

	// Subagent child mode
	private isChildMode: boolean = false;
	private tagPrefix: string | undefined;
	private parentSessionId: string | undefined;
	private ipcClient: IpcClient | null = null;

	// Cold storage reference for conflict tools
	private coldStore: VeilMemoryColdStore | undefined;

	// Pending conflicts for LLM resolution
	private pendingConflicts: PendingConflict[] = [];

	constructor(config: VeilHarnessConfig = {}) {
		this.config = config;
		this.sessionId = config.sessionId;
		this.captureConfig = { ...DEFAULT_CAPTURE_CONFIG, ...config.captureConfig };
		this.learningConfig = { ...this.learningConfig, ...config.learningConfig };

		// Create cold store with conflict callbacks if not provided
		// Cold store uses ~/.veil/cold.db globally with projectId-based isolation
		let coldStore = config.coldStore;
		if (!coldStore) {
			if (config.coldBackend === "engrammic") {
				if (!config.mcpExecutor) {
					throw new Error("[veil] coldBackend='engrammic' requires mcpExecutor");
				}
				coldStore = new EngrammicColdStore({
					mcpServerName: config.engrammic?.mcpServerName,
					siloId: config.engrammic?.siloId,
					tagWithProject: config.engrammic?.tagWithProject,
					defaultDecay: config.engrammic?.defaultDecay,
					mcpExecutor: config.mcpExecutor,
				});
			} else {
				coldStore = this.createLocalColdStore();
			}
		}
		// Save reference for conflict tools (local store only)
		if (coldStore instanceof VeilMemoryColdStore) {
			this.coldStore = coldStore;
		}

		this.manager = new ContextManager(config, coldStore);
		const customTriggers = this.manager.getCache().loadCustomTriggers();
		this.triggers = [...DEFAULT_TRIGGERS, ...customTriggers];

		// Initialize cat widget
		this.catWidget = new CatWidget(config.catConfig);

		// Phase D: Initialize failure-memory
		this.attemptStore = new AttemptStore(this.manager.getCache().getDb());
		this.goalState = createGoalInferenceState();
		this.convergenceMonitor = new ConvergenceMonitor(config.convergenceThresholds);

		// Child mode initialization
		this.isChildMode = config.parentDbPath !== undefined;
		this.tagPrefix = config.tagPrefix;
		this.parentSessionId = config.parentSessionId;

		if (this.isChildMode && config.ipcPath) {
			this.initIpcClient(config.ipcPath);
		}

		if (config.archivePath) {
			this.conversationArchive = new ConversationArchive(config.archivePath);
			// Initialize async — errors are non-fatal
			this.conversationArchive.init().catch((err) => {
				console.error("[veil] ConversationArchive init failed:", err);
				this.conversationArchive = undefined;
			});
		}

		// Async engrammic connection validation (after manager is created)
		if (config.coldBackend === "engrammic" && !config.coldStore && coldStore instanceof EngrammicColdStore) {
			this.validateEngrammicConnection(coldStore, config.engrammic?.fallbackToLocal ?? false);
		}

		// Clean up orphaned child DBs from crashed sessions (parent mode only)
		if (config.dbPath && !this.isChildMode) {
			try {
				const removed = cleanupOrphanedChildDbs(config.dbPath);
				if (removed > 0 && config.onMemoryEvent) {
					config.onMemoryEvent({ type: "sleeping", detail: `Cleaned ${removed} orphaned child DB(s)` });
				}
			} catch {
				// Non-fatal, continue
			}
		}
	}

	/**
	 * Create local VeilMemoryColdStore with conflict callbacks wired to harness events.
	 */
	private createLocalColdStore(): VeilMemoryColdStore {
		return new VeilMemoryColdStore({
			onConflict: (_newId: string, _conflictsWith: string[], content: string) => {
				this.emitMemoryEvent("conflict", content);
			},
			onSemanticConflict: (conflict) => {
				if (!conflict.autoResolved || conflict.resolution === "unresolved") {
					const pendingConflict: PendingConflict = {
						id: `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						subject: conflict.existingContent.slice(0, 50),
						beliefA: {
							eventId: conflict.existingEventId,
							content: conflict.existingContent,
							confidence: conflict.existingConfidence,
							sourceTier: conflict.existingSourceTier as PendingConflict["beliefA"]["sourceTier"],
							recordedAt: Date.now(),
						},
						beliefB: {
							eventId: "new",
							content: conflict.newContent,
							confidence: conflict.newConfidence,
							sourceTier: conflict.newSourceTier as PendingConflict["beliefB"]["sourceTier"],
							recordedAt: Date.now(),
						},
						similarity: conflict.similarity,
						detectedAt: Date.now(),
						suggestion: "Compare the sources and content to determine which belief is correct.",
					};
					this.pendingConflicts.push(pendingConflict);
					this.emitMemoryEvent(
						"conflict",
						`Semantic conflict: "${conflict.existingContent.slice(0, 30)}..." vs new fact`,
					);
				} else if (conflict.autoResolved) {
					this.emitMemoryEvent("learned", `Auto-resolved: ${conflict.reason}`);
				}
			},
		});
	}

	/**
	 * Validate engrammic MCP connection by calling tick.
	 * If unavailable and fallbackToLocal, swaps ContextManager's cold store to local.
	 * Errors are non-fatal: emitted as memory events.
	 */
	private validateEngrammicConnection(store: EngrammicColdStore, fallbackToLocal: boolean): void {
		store
			.count()
			.then(() => {
				this.emitMemoryEvent("sleeping", "engrammic cold store connected");
			})
			.catch((err: unknown) => {
				if (fallbackToLocal) {
					const local = this.createLocalColdStore();
					this.manager.setCold(local);
					this.coldStore = local;
					this.emitMemoryEvent("sleeping", "engrammic unavailable, using local cold store");
				} else {
					this.emitMemoryEvent(
						"sleeping",
						`engrammic cold store unavailable: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			});
	}

	/**
	 * Initialize IPC client connection to parent process.
	 * Sends "ready" message on successful connection.
	 */
	private initIpcClient(socketPath: string): void {
		this.ipcClient = new IpcClient(socketPath);
		this.ipcClient
			.connect()
			.then(() => {
				// Send ready message
				this.ipcClient?.send({ version: 1, type: "ready" });

				// Listen for parent messages
				this.ipcClient?.onMessage((msg) => {
					if (msg.type === "ping") {
						this.ipcClient?.send({ version: 1, type: "pong" });
					}
					// Additional handlers can be added here for interrupt, redirect, etc.
				});
			})
			.catch((err) => {
				console.error(`[veil] IPC connection failed: ${err}`);
				this.ipcClient = null;
			});
	}

	/**
	 * Send a checkpoint message to parent via IPC.
	 * Called on turn completion when in child mode.
	 */
	sendCheckpoint(lastTool?: string): void {
		if (!this.ipcClient?.connected) return;

		this.ipcClient.send({
			version: 1,
			type: "checkpoint",
			turn: this.getTurnCount(),
			tokens: this.getBudget().usedTokens,
			timestamp: Date.now(),
			lastTool,
		});
	}

	/**
	 * Send completion message to parent via IPC.
	 */
	sendComplete(result: string): void {
		if (!this.ipcClient?.connected) return;

		this.ipcClient.send({
			version: 1,
			type: "complete",
			result,
		});
	}

	/**
	 * Send error message to parent via IPC.
	 */
	sendError(message: string): void {
		if (!this.ipcClient?.connected) return;

		this.ipcClient.send({
			version: 1,
			type: "error",
			message,
		});
	}

	/**
	 * Check if this harness is running in child (subagent) mode.
	 */
	getIsChildMode(): boolean {
		return this.isChildMode;
	}

	/**
	 * Get the tag prefix for child mode captures.
	 */
	getTagPrefix(): string | undefined {
		return this.tagPrefix;
	}

	/**
	 * Get the underlying ContextManager for direct access.
	 */
	getManager(): ContextManager {
		return this.manager;
	}

	/**
	 * Get the session ID associated with this harness instance.
	 */
	getSessionId(): string | undefined {
		return this.sessionId;
	}

	/**
	 * Set the current task context (used for relevance scoring).
	 */
	setTaskContext(ctx: TaskContext): void {
		this.currentTaskContext = ctx;
	}

	/**
	 * Get hooks to spread into AgentLoopConfig.
	 *
	 * @example
	 * const config: AgentLoopConfig = {
	 *   ...baseConfig,
	 *   ...harness.getHooks(),
	 * }
	 */
	getHooks() {
		return {
			beforeToolCall: this.beforeToolCall.bind(this),
			afterToolCall: this.afterToolCall.bind(this),
		};
	}

	/**
	 * Hook: called before each tool execution.
	 * Checks eviction and manages context budget.
	 */
	async beforeToolCall(
		context: BeforeToolCallContext,
		_signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		// Extract veil_turn_meta metadata when the model calls it
		if (context.toolCall.name === "veil_turn_meta") {
			const params = context.args as { type?: string; intent_id?: string; decision_summary?: string };
			if (this.conversationArchive && params.type) {
				// Archive the meta annotation as a pseudo-assistant turn
				const metaContent = `[turn-meta: type=${params.type}${params.intent_id ? ` intent=${params.intent_id}` : ""}${params.decision_summary ? ` decision=${params.decision_summary}` : ""}]`;
				await this.archiveTurn("assistant", metaContent);
			}
		}

		// Emit watching event when tool starts
		this.emitMemoryEvent("watching", context.toolCall.name);

		// Update task context based on tool being called
		this.updateTaskContext(context.toolCall.name, context.args);

		// Check triggers for auto-recall before tool execution
		const triggerResult = this.checkTriggers(context.toolCall.name, context.args);
		if (triggerResult && triggerResult.items.length > 0) {
			this.emitMemoryEvent("recalled", `trigger:${triggerResult.reason}`);
		}

		// Check if eviction needed (pass overall context usage for pressure-based eviction)
		const evicted = await this.manager.checkEviction(this.currentTaskContext, this.contextUsagePercent);

		if (evicted.length > 0) {
			// Track evicted tool call IDs for faded history
			let freedTokens = 0;
			for (const candidate of evicted) {
				if (candidate.item.sourceToolCallId) {
					this.evictedToolCallIds.add(candidate.item.sourceToolCallId);
				}
				// Decrement token budget only for items auto-captured by this harness
				if (this.autoCapturedIds.has(candidate.item.id)) {
					const freed = this.estimateTokens(candidate.item.content);
					freedTokens += freed;
					this.tokenBudget.used = Math.max(0, this.tokenBudget.used - freed);
					this.autoCapturedIds.delete(candidate.item.id);
				}
				if (this.tokenBudget.softWarningEmitted) {
					const softLimit = Math.floor(
						this.captureConfig.maxTokenBudget * this.captureConfig.softThresholdPercent,
					);
					if (this.tokenBudget.used <= softLimit) {
						this.tokenBudget.softWarningEmitted = false;
					}
				}
				this.sessionStats.evicted++;
			}
			// Emit eviction event with budget info
			this.emitMemoryEvent("forgetting", `evicted ${evicted.length}, freed ~${freedTokens} tokens`);
			// Emit structured eviction event for extensions
			this.emitEvictionEvent(
				evicted.map((e) => e.item.id),
				freedTokens,
			);
			if (this.config.onEviction) {
				this.config.onEviction(evicted);
			}
		}

		// Don't block any tool calls - just manage context
		return undefined;
	}

	/**
	 * Check for trigger-based auto-recall based on tool name and args.
	 * Returns recalled items and reason, or null if no triggers fired.
	 *
	 * Called in beforeToolCall to surface relevant memories before an action.
	 */
	checkTriggers(toolName: string, args: unknown, result?: unknown): TriggerResult | null {
		const argObj = args as Record<string, unknown> | undefined;

		if (toolName === "Edit" || toolName === "Write") {
			const filePath = argObj?.file_path as string | undefined;
			if (filePath) {
				return handleTrigger(this.manager.getCache(), { type: "pre_edit", filePath });
			}
		}

		if (toolName === "Bash") {
			const command = (argObj?.command ?? argObj?.cmd) as string | undefined;
			if (command && isDangerousCommand(command)) {
				return handleTrigger(this.manager.getCache(), { type: "pre_bash", command });
			}
		}

		if (result !== undefined) {
			const resultObj = result as Record<string, unknown> | undefined;
			const isError =
				resultObj?.isError === true ||
				(typeof resultObj?.content === "string" && /error|exception|failed/i.test(resultObj.content as string));
			if (isError) {
				const errorText =
					typeof resultObj?.content === "string"
						? (resultObj.content as string)
						: JSON.stringify(result).slice(0, 500);
				return handleTrigger(this.manager.getCache(), { type: "error_observed", errorText });
			}
		}

		if (toolName === "Grep" || toolName === "Search") {
			const searchTerms = (argObj?.pattern ?? argObj?.query ?? argObj?.search) as string | undefined;
			if (searchTerms) {
				return handleTrigger(this.manager.getCache(), { type: "pre_search", searchTerms });
			}
		}

		return null;
	}

	/**
	 * Hook: called after each tool execution.
	 * Updates cognitive weights based on success/failure.
	 */
	async afterToolCall(context: AfterToolCallContext, _signal?: AbortSignal): Promise<AfterToolCallResult | undefined> {
		// Archive tool result as a turn
		if (this.conversationArchive && context.toolCall.name !== "veil_turn_meta") {
			const toolSummary = `[tool:${context.toolCall.name}${context.result.isError ? " error" : " ok"}]`;
			await this.archiveTurn("tool", toolSummary);
		}

		// Record outcome for cognitive weight tracking
		const success = !context.result.isError;
		this.manager.recordOutcome(success);

		// Tick turn counter
		const isCheckpoint = this.manager.tick();
		if (isCheckpoint) {
			this.emitCheckpointEvent();
			if (this.config.onCheckpoint) {
				this.config.onCheckpoint(this.getTurnCount());
			}
		}

		return undefined;
	}

	/**
	 * Subscribe to tool_result events from Pi's AgentHarness.
	 * The returned unsubscribe function is stored and called automatically on close().
	 */
	subscribeToEvents(agentHarness: {
		on: (type: "tool_result", handler: (event: ToolResultEvent) => void) => () => void;
	}): void {
		this.unsubscribe = agentHarness.on("tool_result", this.handleToolResult.bind(this));
	}

	/**
	 * Handle a tool_result event from Pi's agent loop.
	 */
	private handleToolResult(event: ToolResultEvent): void {
		const turn = this.manager.getTurnCount();

		// Phase D: Detect failures and record attempts
		const detection = detectFailure(event);
		if (detection.outcome === "fail" || detection.outcome === "uncertain") {
			const goalId = inferGoalId(event, this.goalState);
			const target = extractTarget(event);

			const attempt: AttemptRecord = {
				id: `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				sessionId: this.sessionId ?? "unknown",
				goalId,
				iteration: this.attemptStore.countByGoal(goalId) + 1,
				action: event.toolName,
				target: target ?? undefined,
				rationale: undefined,
				outcome: detection.outcome,
				evidence: detection.evidence,
				errorPattern: detection.errorPattern,
				createdAt: Date.now(),
				turn,
				goalOpen: true,
				pinned: false,
			};
			this.attemptStore.put(attempt);

			// Phase D.3: Update convergence monitor and fire callbacks
			const escalation = this.convergenceMonitor.update(attempt, turn);
			if (escalation.level >= 2 && this.config.onConvergenceWarning) {
				const state = this.convergenceMonitor.getState(goalId);
				if (state) this.config.onConvergenceWarning(state, escalation);
			}
			if (escalation.level >= 3 && this.config.onConvergenceHalt) {
				const state = this.convergenceMonitor.getState(goalId);
				if (state) this.config.onConvergenceHalt(state, escalation);
			}

			// Update goal state
			this.goalState = advanceGoalState(this.goalState, goalId, target, turn);
		} else if (detection.outcome === "pass") {
			// Update goal state on success (goal closure handled in D.4.7)
			const goalId = inferGoalId(event, this.goalState);
			const target = extractTarget(event);
			this.goalState = advanceGoalState(this.goalState, goalId, target, turn);
		}

		// Continue with auto-capture for non-errors
		if (!event.isError) {
			this.autoCapture(event.toolName, event.input, event.content, event.toolCallId, false, undefined);
		}
	}

	/**
	 * Auto-capture a tool result into the warm cache, respecting rate limits and deduplication.
	 */
	private autoCapture(
		toolName: string,
		args: unknown,
		content: Array<{ type: string; text?: string }>,
		toolCallId?: string,
		isError: boolean = false,
		exitCode?: number,
	): void {
		// Check rate limits
		if (this.capturesThisTurn >= this.captureConfig.maxItemsPerTurn) return;
		if (this.totalCaptures >= this.captureConfig.maxItemsPerSession) return;

		// Get capture rule
		const rule = getCaptureRule(toolName, args);
		if (!rule) return;

		// Extract text content
		const text = extractContent(content);
		if (text.length < this.captureConfig.minChars) return;

		// Compute dedupeKey early so it can be passed into the extractor for upgrades
		const argObj = args as Record<string, unknown> | undefined;
		const resolvedDedupeKeyForExtractor = rule.dedupeKey
			? argObj?.file_path
				? `${rule.dedupeKey}:${argObj.file_path}`
				: rule.dedupeKey
			: undefined;

		// Run extractor to filter/transform content
		const extractor = getExtractor(rule.extractor ?? "passthrough");
		const extracted = extractor({
			toolName,
			args: (args as Record<string, unknown>) ?? {},
			content: text,
			isError,
			exitCode,
			cache: this.manager.getCache(),
			dedupeKey: resolvedDedupeKeyForExtractor,
		});
		if (extracted.skipCapture) return;

		if (rule.debounceWindowMs) {
			const argObj = args as Record<string, unknown> | undefined;
			const filePath = argObj?.file_path;
			// Always include file path so edits to different files get separate debounce slots
			const dedupeKey = rule.dedupeKey
				? `${rule.dedupeKey}:${filePath ?? toolCallId ?? Date.now()}`
				: `${toolName}:${filePath ?? toolCallId ?? Date.now()}`;
			const pending = this.pendingCaptures.get(dedupeKey);
			if (pending) {
				clearTimeout(pending.timer);
				pending.latestExtracted = extracted;
				pending.count++;
			}
			const entry = pending ?? {
				rule,
				latestExtracted: extracted,
				count: 1,
				toolName,
				args,
				toolCallId,
				timer: undefined as unknown as NodeJS.Timeout,
			};
			entry.timer = setTimeout(() => {
				this.pendingCaptures.delete(dedupeKey);
				this.commitCapture(entry.toolName, entry.args, entry.rule, entry.latestExtracted, entry.toolCallId);
			}, rule.debounceWindowMs);
			this.pendingCaptures.set(dedupeKey, entry);
			return;
		}

		this.commitCapture(toolName, args, rule, extracted, toolCallId);
	}

	/**
	 * Simple token estimator: ~4 chars per token.
	 */
	private estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	/**
	 * Commit an extracted capture to the warm cache.
	 */
	private commitCapture(
		toolName: string,
		args: unknown,
		rule: EnhancedCaptureRule,
		extracted: ExtractorResult,
		toolCallId?: string,
	): void {
		// Check rate limits at commit time
		if (this.capturesThisTurn >= this.captureConfig.maxItemsPerTurn) return;
		if (this.totalCaptures >= this.captureConfig.maxItemsPerSession) return;

		// Normalize to OKF-style CaptureDocument
		const doc = normalizeCapture(toolName, args, extracted, rule);

		// Build metadata for content-type detection
		const argObj = args as Record<string, unknown> | undefined;
		const metadata: ContentMetadata = {
			filePath: argObj?.file_path as string | undefined,
			toolName,
			tags: doc.tags,
		};

		// Compress by content type (sync path: config, conversation; code needs async parser)
		const { compressed, ratio } = compressSync(doc.body, { metadata });

		// Use compressed if it saved space, otherwise truncate original
		const toStore = ratio < 1 ? compressed : smartTruncate(doc.body, this.captureConfig.maxChars);

		// Token budget check
		const incomingTokens = this.estimateTokens(toStore);
		const softLimit = Math.floor(this.captureConfig.maxTokenBudget * this.captureConfig.softThresholdPercent);

		if (this.tokenBudget.used + incomingTokens > this.captureConfig.maxTokenBudget) {
			this.emitMemoryEvent(
				"budget_exceeded",
				`skipping ${toolName}: budget full (${this.tokenBudget.used}/${this.captureConfig.maxTokenBudget} tokens)`,
			);
			return;
		}

		if (!this.tokenBudget.softWarningEmitted && this.tokenBudget.used + incomingTokens > softLimit) {
			this.tokenBudget.softWarningEmitted = true;
			this.emitMemoryEvent(
				"budget_warning",
				`capture budget at ${Math.round(((this.tokenBudget.used + incomingTokens) / this.captureConfig.maxTokenBudget) * 100)}%`,
			);
		}

		// Build semantic dedup key from rule prefix + file_path (if rule defines one)
		const resolvedDedupeKey = rule.dedupeKey
			? argObj?.file_path
				? `${rule.dedupeKey}:${argObj.file_path}`
				: rule.dedupeKey
			: undefined;

		// Check semantic dedup key first (same file, different content)
		if (resolvedDedupeKey) {
			const existingByKey = this.manager.getCache().getByDedupeKey(resolvedDedupeKey);
			if (existingByKey) {
				this.manager.getCache().touch(existingByKey.id);
				return;
			}
		}

		// Check for duplicates — use the same hash function as createItem (cache.ts)
		const hash = hashContent(toStore);
		const existing = this.manager.getCache().getByHash(hash);
		if (existing) {
			this.manager.getCache().touch(existing.id);
			return;
		}

		// Generate tags: CaptureDocument tags + internal structural tags
		const tags = [...doc.tags, ...generateInternalTags(toolName, args)];

		// Store in warm cache with tool call ID for faded history
		this.emitMemoryEvent("remembering", toolName);
		const item = this.manager.remember(toStore, rule.type, tags, toolCallId, resolvedDedupeKey);

		// Persist CaptureDocument links for graph traversal
		if (doc.links.length > 0) {
			this.manager.getCache().addLinks(item.id, doc.links);
		}

		this.autoCapturedIds.add(item.id);
		this.emitMemoryEvent("learned", `captured ${toolName}`);
		this.tokenBudget.used += incomingTokens;
		this.capturesThisTurn++;
		this.totalCaptures++;
	}

	/**
	 * Flush all pending debounced captures immediately (e.g., on session end).
	 */
	flushPendingCaptures(): void {
		const entries = [...this.pendingCaptures.values()];
		for (const entry of entries) {
			clearTimeout(entry.timer);
		}
		this.pendingCaptures.clear();
		for (const entry of entries) {
			try {
				this.commitCapture(entry.toolName, entry.args, entry.rule, entry.latestExtracted, entry.toolCallId);
			} catch (e) {
				console.error("[veil] flush capture failed:", e);
			}
		}
	}

	/**
	 * Reset per-turn capture counter. Call at turn boundaries.
	 */
	resetTurnCaptures(): void {
		this.capturesThisTurn = 0;
		// Phase D: Update goal state turn counter
		this.goalState.turn = this.manager.getTurnCount();
	}

	/**
	 * Get the AttemptStore for failure-memory queries.
	 */
	getAttemptStore(): AttemptStore {
		return this.attemptStore;
	}

	/**
	 * Get current goal inference state.
	 */
	getGoalState(): GoalInferenceState {
		return this.goalState;
	}

	/**
	 * Build the failure section for context injection.
	 * Returns empty string if no relevant failures exist for the current goal.
	 * Includes convergence warnings when applicable.
	 */
	getFailureSection(): string {
		const goalId = this.goalState.currentGoalId;
		if (!goalId) return "";

		const attempts = this.attemptStore.getOpenByGoal(goalId);
		if (attempts.length === 0) return "";

		const failureBlock = buildFailureSection({
			attempts,
			currentTurn: this.manager.getTurnCount(),
		});

		// D.3.5: Add convergence warning if applicable
		const state = this.convergenceMonitor.getState(goalId);
		if (state) {
			const lastAttempt = attempts[attempts.length - 1];
			const escalation = this.convergenceMonitor.checkConvergence(state, lastAttempt);
			if (escalation.level >= 1) {
				const warning = buildConvergenceWarning(state, escalation);
				return `${failureBlock}\n\n${warning}`;
			}
		}

		return failureBlock;
	}

	/**
	 * Get convergence state for a goal.
	 */
	getConvergenceState(goalId: string): ConvergenceState | null {
		return this.convergenceMonitor.getState(goalId);
	}

	/**
	 * Get convergence monitor for direct access (testing/debugging).
	 */
	getConvergenceMonitor(): ConvergenceMonitor {
		return this.convergenceMonitor;
	}

	/**
	 * Archive a conversation turn. Classifies it and persists to the conversation archive.
	 * No-op when no archivePath was configured.
	 */
	async archiveTurn(role: "user" | "assistant" | "tool", content: string): Promise<void> {
		if (!this.conversationArchive) return;

		this.turnCounter++;
		const meta = role !== "tool" ? classifyTurn(content, role) : { type: "action" as const };
		const cleanContent = role === "assistant" ? stripTurnMeta(content) : content;

		const turn: ArchivedTurn = {
			turnId: `${this.sessionId ?? "session"}-${this.turnCounter}`,
			sessionId: this.sessionId ?? "unknown",
			turnNumber: this.turnCounter,
			role,
			content: cleanContent,
			metaType: meta.type,
			intentId: meta.intentId,
			decisionSummary: meta.decisionSummary,
		};

		await this.conversationArchive.archiveTurn(turn);

		// Check for rerequest feedback in user messages
		if (role === "user") {
			const feedback = detectRerequest(content, this.turnCounter);
			if (feedback) {
				this.evictionFeedbackTracker.record(feedback);
			}
		}
	}

	/**
	 * Evict conversation turns to reclaim approximately targetTokens of context space.
	 * Returns the turn IDs that were evicted.
	 */
	async evictConversationTurns(targetTokens: number): Promise<string[]> {
		if (!this.conversationArchive) return [];

		const allTurns = await this.conversationArchive.getTurnRange(this.sessionId ?? "unknown", 1, this.turnCounter);

		if (allTurns.length === 0) return [];

		// Build scored candidates with reference penalty (1.0 when no embeddings)
		const candidates = allTurns.map((t) => {
			const referencePenalty = t.embedding
				? computeReferencePenalty(
						{ turnId: t.turnId, turnNumber: t.turnNumber, embedding: t.embedding },
						allTurns
							.filter((r) => r.embedding && r.turnNumber > t.turnNumber)
							.slice(-5)
							.map((r) => ({ turnId: r.turnId, turnNumber: r.turnNumber, embedding: r.embedding! })),
					)
				: 1.0;
			return { turnId: t.turnId, turnNumber: t.turnNumber, type: t.metaType ?? "action", referencePenalty };
		});

		const ranked = rankForEviction(candidates, this.turnCounter);

		const tokenCounts = new Map<string, number>(allTurns.map((t) => [t.turnId, estimateTokens(t.content)]));

		const toEvict = selectForEviction(ranked, tokenCounts, targetTokens);
		if (toEvict.length === 0) return [];

		// Generate stubs for evicted turns grouped together
		const evictedTurns = allTurns.filter((t) => toEvict.includes(t.turnId));
		const stub = generateStub({ turns: evictedTurns });
		this.evictionStubs.push(stub);

		// Mark evicted in archive
		for (const turnId of toEvict) {
			await this.conversationArchive.markEvicted(turnId, stub);
		}

		return toEvict;
	}

	/**
	 * Get stub text for evicted conversation turns (for context injection).
	 */
	getEvictionStubs(): string[] {
		return [...this.evictionStubs];
	}

	/**
	 * Get the eviction feedback tracker for threshold tuning.
	 */
	getEvictionFeedbackTracker(): EvictionFeedbackTracker {
		return this.evictionFeedbackTracker;
	}

	/**
	 * Get the conversation archive instance (may be undefined if not configured).
	 */
	getConversationArchive(): ConversationArchive | undefined {
		return this.conversationArchive;
	}

	/**
	 * Update task context based on tool usage.
	 */
	private updateTaskContext(toolName: string, args: unknown): void {
		// Extract relevant context from tool calls
		const argObj = args as Record<string, unknown> | undefined;

		if (toolName === "Read" && argObj?.file_path) {
			this.currentTaskContext.currentFile = String(argObj.file_path);
		}

		// Add tool-specific tags
		const toolTags: Record<string, string[]> = {
			Read: ["file", "read"],
			Write: ["file", "write"],
			Edit: ["file", "edit"],
			Bash: ["shell", "command"],
			Grep: ["search", "code"],
		};

		if (toolTags[toolName]) {
			this.currentTaskContext.tags = [...new Set([...this.currentTaskContext.tags, ...toolTags[toolName]])];
		}
	}

	/**
	 * Get current turn count.
	 */
	getTurnCount(): number {
		return this.manager.getTurnCount();
	}

	/**
	 * Get context window state.
	 */
	getWindow() {
		return this.manager.getWindow();
	}

	/**
	 * Get budget status.
	 */
	getBudget() {
		return this.manager.getBudget();
	}

	/**
	 * Get capture token budget state.
	 */
	getCaptureBudget(): { used: number; max: number; softThreshold: number; softWarningEmitted: boolean } {
		return {
			used: this.tokenBudget.used,
			max: this.captureConfig.maxTokenBudget,
			softThreshold: Math.floor(this.captureConfig.maxTokenBudget * this.captureConfig.softThresholdPercent),
			softWarningEmitted: this.tokenBudget.softWarningEmitted,
		};
	}

	/**
	 * Get usage statistics for status bar display.
	 */
	getUsage(): UsageStats {
		const window = this.manager.getWindow();
		const budget = window.budget;
		const hotTokens = window.items.reduce((sum, item) => sum + estimateTokens(item.content), 0);
		const available = budget.maxTokens - budget.reserveTokens;
		const percent = available > 0 ? (hotTokens / available) * 100 : 0;

		return {
			hotTokens,
			hotItems: window.items.length,
			budgetMax: budget.maxTokens,
			budgetUsed: budget.usedTokens,
			budgetReserve: budget.reserveTokens,
			percent,
		};
	}

	/**
	 * Get and clear evicted tool call IDs since last call.
	 * Used by the Pi extension to dim corresponding messages.
	 */
	getAndClearEvictedToolCallIds(): string[] {
		const ids = Array.from(this.evictedToolCallIds);
		this.evictedToolCallIds.clear();
		return ids;
	}

	/**
	 * Emit a memory event to registered callbacks and listeners.
	 * Also updates cat widget state and tracks session stats.
	 */
	private emitMemoryEvent(type: MemoryEventType, detail?: string): void {
		// Include usage stats for budget-related events
		const includeUsage = [
			"forgetting",
			"budget_exceeded",
			"budget_warning",
			"learned",
			"remembering",
			"context_update",
		].includes(type);
		let usage: MemoryEvent["usage"];
		if (includeUsage) {
			const stats = this.getUsage();
			usage = {
				contextPercent: this.contextUsagePercent,
				hotTokens: stats.hotTokens,
				hotItems: stats.hotItems,
				budgetMax: stats.budgetMax,
				budgetUsed: stats.budgetUsed,
			};
		}
		const event: MemoryEvent = { type, detail, usage };

		// Update cat widget state (only forward states the widget understands)
		const CAT_STATES = new Set([
			"sleeping",
			"watching",
			"remembering",
			"learned",
			"recalled",
			"forgetting",
			"conflict",
		]);
		if (CAT_STATES.has(type)) {
			this.catWidget.setState({
				state: type as "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "forgetting" | "conflict",
				detail,
			});
		}

		// Track session stats
		if (type === "remembering") {
			this.sessionStats.remembered++;
		} else if (type === "learned") {
			this.sessionStats.learned++;
		} else if (type === "recalled") {
			this.sessionStats.recalled++;
		} else if (type === "conflict") {
			this.sessionStats.conflicts++;
		}

		this.config.onMemoryEvent?.(event);
		for (const listener of this.memoryEventListeners) {
			listener(event);
		}
	}

	/**
	 * Emit a structured eviction event for extensions.
	 */
	private emitEvictionEvent(evictedIds: string[], tokensFreed: number): void {
		const event: MemoryEvent = {
			type: "eviction",
			detail: `${evictedIds.length} items evicted`,
			eviction: {
				evictedIds,
				tokensFreed,
				turn: this.getTurnCount(),
			},
		};
		this.config.onMemoryEvent?.(event);
		for (const listener of this.memoryEventListeners) {
			listener(event);
		}
	}

	/**
	 * Emit a structured checkpoint event for extensions.
	 */
	private emitCheckpointEvent(): void {
		const window = this.getWindow();
		const warmStats = this.manager.getCache().getTypeCounts();
		const warmCount = (warmStats.episodic ?? 0) + (warmStats.fact ?? 0) + (warmStats.procedural ?? 0);
		const budgetPercent =
			window.budget.maxTokens > 0 ? (window.budget.usedTokens / window.budget.maxTokens) * 100 : 0;

		const event: MemoryEvent = {
			type: "checkpoint",
			detail: `turn ${this.getTurnCount()}`,
			checkpoint: {
				turn: this.getTurnCount(),
				hotCount: window.items.length,
				warmCount,
				budgetPercent,
			},
		};
		this.config.onMemoryEvent?.(event);
		for (const listener of this.memoryEventListeners) {
			listener(event);
		}
	}

	/**
	 * Subscribe to memory events. Returns an unsubscribe function.
	 */
	onMemoryEvent(listener: (event: MemoryEvent) => void): () => void {
		this.memoryEventListeners.push(listener);
		return () => {
			const idx = this.memoryEventListeners.indexOf(listener);
			if (idx >= 0) this.memoryEventListeners.splice(idx, 1);
		};
	}

	/**
	 * Get the cat widget instance.
	 */
	getCatWidget(): CatWidget {
		return this.catWidget;
	}

	/**
	 * Render the cat widget's current state as ASCII art.
	 */
	renderCat(): string {
		if (!this.catEnabled) return "";
		return this.catWidget.render();
	}

	/**
	 * Render session-end summary with the cat.
	 */
	renderSessionEnd(): string {
		if (!this.catEnabled) return "";
		return this.catWidget.renderSessionEnd(this.sessionStats);
	}

	/**
	 * Check if cat widget is enabled.
	 */
	isCatEnabled(): boolean {
		return this.catEnabled;
	}

	/**
	 * Toggle cat widget on/off.
	 */
	toggleCat(enabled?: boolean): boolean {
		this.catEnabled = enabled ?? !this.catEnabled;
		return this.catEnabled;
	}

	/**
	 * Get session stats for memory operations.
	 */
	getSessionStats(): SessionStats {
		return { ...this.sessionStats };
	}

	/**
	 * Track an eviction in session stats.
	 */
	trackEviction(): void {
		this.sessionStats.evicted++;
	}

	/**
	 * Remember something (store in warm cache).
	 * For facts, also checks cold storage for conflicts.
	 */
	remember(content: string, type: "episodic" | "procedural" | "fact", tags: string[] = [], toolCallId?: string) {
		this.emitMemoryEvent("remembering", content.slice(0, 50));
		const result = this.manager.remember(content, type, tags, toolCallId);
		this.emitMemoryEvent("learned", type);

		// Check for conflicts with cold storage on factual items
		if (type === "fact" && this.config.coldStore instanceof VeilMemoryColdStore) {
			const conflicts = this.config.coldStore.getConflicts();
			// Extract subject from first tag or content prefix
			const subject = tags[0] ?? content.slice(0, 50).replace(/\n/g, " ").trim();
			const subjectHash = hashContent(subject);
			const matching = conflicts.filter((c) => c.subjectHash === subjectHash);
			if (matching.length > 0) {
				this.emitMemoryEvent("conflict", `${matching.length} conflicting belief(s) on "${subject.slice(0, 30)}"`);
			}
		}

		return result;
	}

	/**
	 * Recall items by tags.
	 * Also checks if any recalled items have conflicts in cold storage.
	 */
	async recall(tags: string[], limit = 10) {
		this.emitMemoryEvent("watching", `searching ${tags.join(", ")}`);
		const result = await this.manager.recall(tags, limit);
		this.emitMemoryEvent("recalled", `found ${result.length} items`);

		// Check for conflicts among recalled items
		if (result.length > 0 && this.config.coldStore instanceof VeilMemoryColdStore) {
			const conflicts = this.config.coldStore.getConflicts();
			const recalledIds = new Set(result.map((r) => r.id));
			const matching = conflicts.filter((c) => recalledIds.has(c.eventIdA) || recalledIds.has(c.eventIdB));
			if (matching.length > 0) {
				this.emitMemoryEvent("conflict", `${matching.length} conflict(s) in recalled items`);
			}
		}

		return result;
	}

	/**
	 * Search across hot (in-memory) and warm (SQLite) context tiers.
	 * Hot items score 1.0, warm items score 0.8. Hot items win on dedup.
	 */
	search(query: string, limit: number = 10): SearchResult[] {
		const lowerQuery = query.toLowerCase();

		// 1. Filter hot items (in-memory) - score 1.0
		const window = this.manager.getWindow();
		const hotResults: SearchResult[] = window.items
			.filter(
				(item) =>
					item.content.toLowerCase().includes(lowerQuery) ||
					item.tags.some((tag) => tag.toLowerCase().includes(lowerQuery)),
			)
			.map((item) => ({
				id: item.id,
				tier: "hot" as const,
				type: item.type,
				summary: item.content.slice(0, 40),
				tokens: estimateTokens(item.content),
				score: 1.0,
				tags: item.tags,
			}));

		// 2. Search warm via cache.searchItems() - score 0.8
		const hotIds = new Set(hotResults.map((r) => r.id));
		const warmItems = this.manager.getCache().searchItems(query, limit);
		const warmResults: SearchResult[] = warmItems
			.filter((item) => !hotIds.has(item.id))
			.map((item) => ({
				id: item.id,
				tier: "warm" as const,
				type: item.type,
				summary: item.content.slice(0, 40),
				tokens: estimateTokens(item.content),
				score: 0.8,
				tags: item.tags,
			}));

		// 3. Merge (hot first), return up to limit
		return [...hotResults, ...warmResults].slice(0, limit);
	}

	/**
	 * Load items into active context.
	 */
	load(ids: string[]) {
		return this.manager.load(ids);
	}

	/**
	 * Unload items from active context.
	 */
	unload(ids: string[]) {
		return this.manager.unload(ids);
	}

	/**
	 * Pin an item to prevent eviction.
	 */
	pin(id: string) {
		return this.manager.pin(id);
	}

	/**
	 * Unpin an item.
	 */
	unpin(id: string) {
		return this.manager.unpin(id);
	}

	/**
	 * Forget an item entirely.
	 * Also decrements capture budget if item was auto-captured.
	 */
	async forget(id: string) {
		this.emitMemoryEvent("forgetting", id.slice(0, 20));
		// Decrement capture budget if this was an auto-captured item
		if (this.autoCapturedIds.has(id)) {
			const item = this.manager.getWindow().items.find((i) => i.id === id);
			if (item) {
				const freed = this.estimateTokens(item.content);
				this.tokenBudget.used = Math.max(0, this.tokenBudget.used - freed);
			}
			this.autoCapturedIds.delete(id);
		}
		return this.manager.forget(id);
	}

	/**
	 * Fetch from cold storage.
	 */
	async fetchFromCold(pointer: string) {
		return this.manager.fetchFromCold(pointer);
	}

	/**
	 * Update the overall context window usage (0-100%).
	 * Called by agent-session to inform eviction decisions.
	 */
	setContextUsage(percent: number): void {
		const newPercent = Math.max(0, Math.min(100, percent));
		const changed = Math.abs(newPercent - this.contextUsagePercent) >= 1;
		this.contextUsagePercent = newPercent;
		// Emit update event when context usage changes significantly (>=1%)
		if (changed) {
			this.emitMemoryEvent("context_update");
		}
	}

	/**
	 * Get the current context usage percentage.
	 */
	getContextUsage(): number {
		return this.contextUsagePercent;
	}

	/**
	 * Force eviction sweep. Demotes low-score items to cold storage.
	 * Called by /compact command for manual context reduction.
	 * Always passes 100% context usage to trigger aggressive eviction.
	 */
	async forceEviction(): Promise<EvictionCandidate[]> {
		const taskCtx: TaskContext = {
			tags: [],
		};
		// Force eviction by simulating 100% context pressure
		return this.manager.checkEviction(taskCtx, 100);
	}

	/**
	 * Get tool definitions for agent registration.
	 */
	getTools(): ToolDefinition[] {
		return TOOL_SCHEMAS;
	}

	/**
	 * Execute a veil tool by name.
	 */
	async executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
		// Emit pre-execution events
		if (name === "veil_recall" || name === "veil_hydrate" || name === "veil_history") {
			this.emitMemoryEvent("watching", `${name}...`);
		} else if (name === "veil_remember") {
			this.emitMemoryEvent("remembering", (params.content as string)?.slice(0, 30));
		}

		const result = await executeVeilTool(name, params, {
			manager: this.manager,
			coldStore: this.coldStore,
			onRecall: (ids) => this.onRecall(ids),
		});

		// Emit post-execution events for session stats tracking
		if (result.success) {
			if (name === "veil_recall" || name === "veil_hydrate" || name === "veil_history") {
				this.emitMemoryEvent("recalled", name);
			} else if (name === "veil_remember") {
				this.emitMemoryEvent("learned", params.type as string);
			} else if (name === "veil_promote") {
				this.emitMemoryEvent("recalled", "promoted");
			} else if (name === "veil_pin") {
				this.emitMemoryEvent("learned", "pinned");
			} else if (name === "veil_conflicts") {
				const data = result.data as { conflicts?: unknown[] } | undefined;
				if (data?.conflicts && data.conflicts.length > 0) {
					this.emitMemoryEvent("conflict", `${data.conflicts.length} conflict(s)`);
				}
			} else if (name === "veil_resolve_conflict") {
				this.emitMemoryEvent("learned", "resolved conflict");
				// Clear resolved conflict from pending queue
				const resolvedData = result.data as { resolved?: string } | undefined;
				if (resolvedData?.resolved) {
					// Find and remove any pending conflict involving this event ID
					this.pendingConflicts = this.pendingConflicts.filter(
						(c) => c.beliefA.eventId !== resolvedData.resolved && c.beliefB.eventId !== resolvedData.resolved,
					);
				}
			} else if (name === "veil_forget") {
				// Also clear conflicts involving forgotten items
				const forgetParams = params as { id?: string };
				if (forgetParams.id) {
					this.pendingConflicts = this.pendingConflicts.filter(
						(c) => c.beliefA.eventId !== forgetParams.id && c.beliefB.eventId !== forgetParams.id,
					);
				}
			}
		}

		return result;
	}

	/**
	 * Called when items are recalled via veil_recall. Logs hydration events for manifest items.
	 * Uses the bundled ManifestContext snapshot set by processUserMessage.
	 * Clears the manifest after logging to prevent stale data reuse.
	 */
	private onRecall(ids: string[]): void {
		const MANIFEST_STALE_MS = 5 * 60 * 1000; // 5 minutes
		const now = Date.now();

		if (!this.currentManifest) return;
		if (now - this.currentManifest.timestamp > MANIFEST_STALE_MS) {
			this.currentManifest = null;
			return;
		}

		const manifest = this.currentManifest;
		this.currentManifest = null; // Clear to prevent stale data reuse

		for (const id of ids) {
			if (manifest.itemIds.has(id)) {
				this.manager.getCache().logHydration({
					sessionId: this.sessionId ?? "unknown",
					itemId: id,
					triggerIds: manifest.triggerIds,
					userMessage: manifest.userMessage,
					hydratedAt: now,
					latencyMs: now - manifest.timestamp,
				});
			}
		}
	}

	/**
	 * Get pending conflicts that need LLM resolution.
	 * Returns formatted string for context injection, or null if no conflicts.
	 */
	getConflictSection(): string | null {
		if (this.pendingConflicts.length === 0) return null;

		const lines = ["MEMORY CONFLICT DETECTED - Resolution Required:", ""];

		for (const conflict of this.pendingConflicts) {
			const tierLabel = (tier: string) => {
				const labels: Record<string, string> = {
					authoritative: "authoritative source",
					validated: "validated",
					observed: "observed",
					inferred: "inferred",
				};
				return labels[tier] ?? tier;
			};

			const formatAge = (ts: number) => {
				const ms = Date.now() - ts;
				const mins = Math.floor(ms / 60000);
				if (mins < 60) return `${mins}min ago`;
				const hours = Math.floor(mins / 60);
				if (hours < 24) return `${hours}hr ago`;
				return `${Math.floor(hours / 24)}d ago`;
			};

			lines.push(`Conflict ID: ${conflict.id}`);
			lines.push(`Similarity: ${(conflict.similarity * 100).toFixed(0)}%`);
			lines.push("");
			lines.push(`Belief A: "${conflict.beliefA.content}"`);
			lines.push(
				`  - Source: ${tierLabel(conflict.beliefA.sourceTier)}${conflict.beliefA.sourceToolName ? ` (${conflict.beliefA.sourceToolName})` : ""}`,
			);
			lines.push(`  - Confidence: ${conflict.beliefA.confidence.toFixed(2)}`);
			lines.push(`  - Recorded: ${formatAge(conflict.beliefA.recordedAt)}`);
			lines.push(`  - Event ID: ${conflict.beliefA.eventId}`);
			lines.push("");
			lines.push(`Belief B: "${conflict.beliefB.content}"`);
			lines.push(
				`  - Source: ${tierLabel(conflict.beliefB.sourceTier)}${conflict.beliefB.sourceToolName ? ` (${conflict.beliefB.sourceToolName})` : ""}`,
			);
			lines.push(`  - Confidence: ${conflict.beliefB.confidence.toFixed(2)}`);
			lines.push(`  - Recorded: ${formatAge(conflict.beliefB.recordedAt)}`);
			lines.push(`  - Event ID: ${conflict.beliefB.eventId}`);
			lines.push("");
			if (conflict.suggestion) {
				lines.push(`Suggestion: ${conflict.suggestion}`);
			}
			lines.push(
				"Action: Use veil_resolve_conflict to pick the correct belief, or veil_forget to remove the incorrect one.",
			);
			lines.push("---");
		}

		return lines.join("\n");
	}

	/**
	 * Get pending conflicts array.
	 */
	getPendingConflicts(): PendingConflict[] {
		return [...this.pendingConflicts];
	}

	/**
	 * Clear a resolved conflict from the pending queue.
	 */
	clearConflict(conflictId: string): void {
		this.pendingConflicts = this.pendingConflicts.filter((c) => c.id !== conflictId);
	}

	/**
	 * Clear all pending conflicts.
	 */
	clearAllConflicts(): void {
		this.pendingConflicts = [];
	}

	/**
	 * Build context section for system prompt injection.
	 */
	getContextSection(): string {
		const window = this.manager.getWindow();
		const rankedItems = rankItems(window.items, this.currentTaskContext, this.manager.getConfig());
		return buildContextSection({
			items: rankedItems.map(({ item, score }) => ({ item, score })),
			budget: window.budget,
		});
	}

	/**
	 * Get the context management prompt for system prompt injection.
	 * This teaches the model how to use veil tools effectively.
	 */
	getSystemPromptSection(): string {
		return CONTEXT_MANAGEMENT_PROMPT;
	}

	/**
	 * Get a checkpoint nudge if budget is tight or items need review.
	 * Returns null if no nudge is warranted.
	 */
	getCheckpointNudge(): string | null {
		const window = this.manager.getWindow();
		const budget = window.budget;
		const budgetUsedPercent = budget.maxTokens > 0 ? (budget.usedTokens / budget.maxTokens) * 100 : 0;

		const rankedItems = rankItems(window.items, this.currentTaskContext, this.manager.getConfig());
		const lowScoring = rankedItems.filter((r) => r.score < 0.5 && !r.item.pinned);

		// Nudge if budget > 60% used OR more than 3 low-scoring items
		if (budgetUsedPercent < 60 && lowScoring.length < 3) {
			return null;
		}

		return buildCheckpointPrompt({
			turnCount: this.manager.getTurnCount(),
			items: rankedItems.map(({ item, score }) => ({
				stub: formatStub(item),
				score,
				tokens: estimateTokens(item.content),
				pinned: item.pinned ?? false,
			})),
			budget,
		});
	}

	/**
	 * Detect and hydrate stubs mentioned in agent output.
	 * Returns hydrated block to inject, or empty string if none.
	 */
	processAutoHydration(agentOutput: string): string {
		const MAX_STUBS_PER_CALL = 5;
		const stubs = detectStubs(agentOutput);
		if (stubs.length === 0) return "";

		const cappedStubs = stubs.slice(0, MAX_STUBS_PER_CALL);
		if (stubs.length > MAX_STUBS_PER_CALL) {
			console.warn(`[veil] processAutoHydration: ${stubs.length} stubs detected, capping at ${MAX_STUBS_PER_CALL}`);
		}

		const results = cappedStubs.map((stub) => ({
			stub,
			result: hydrateStub(stub, this.manager.getCache()),
		}));

		return formatHydratedBlock(results);
	}

	/**
	 * Process user message for anticipatory loading.
	 * Returns formatted manifest string if triggers match, null otherwise.
	 */
	async processUserMessage(message: string): Promise<string | null> {
		const startTime = Date.now(); // Capture at start to measure full latency
		const triggers = matchTriggers(message, this.triggers);
		if (triggers.length === 0) return null;

		const budget = this.getUsage();
		if (budget.percent > 70) return null;

		let manifest: ContextManifest | null;
		try {
			manifest = await buildManifest(
				triggers,
				this.manager.getCache(),
				{ percent: budget.percent },
				this.config.coldStore,
			);
		} catch (err) {
			// Log error, don't block agent flow
			console.error("[veil] manifest build failed:", err);
			return null;
		}

		if (!manifest) return null;

		// Track for Phase 6 learning
		this.trackManifestItems(manifest, message, startTime);

		// Eager preload if budget allows
		if (budget.percent < 50) {
			this.preloadTopItems(manifest, 3);
		}

		return formatManifest(manifest);
	}

	/**
	 * Track manifest items for future learning (Phase 6).
	 * Bundles all related state into a single ManifestContext snapshot to prevent temporal coupling.
	 */
	private trackManifestItems(manifest: ContextManifest, userMessage: string, startTime: number): void {
		this.currentManifest = {
			itemIds: new Set(manifest.items.map((item) => item.id)),
			triggerIds: manifest.triggers,
			userMessage,
			timestamp: startTime, // Use startTime to capture full latency from message receipt
		};
	}

	/**
	 * Preload top N manifest items into hot context.
	 */
	private preloadTopItems(manifest: ContextManifest, limit: number): void {
		const ids = manifest.items.slice(0, limit).map((i) => i.id);
		this.load(ids); // Existing method, handles dedup
	}

	/**
	 * Check if an item ID was in the current manifest (for Phase 6 learning).
	 */
	wasInManifest(id: string): boolean {
		return this.currentManifest?.itemIds.has(id) ?? false;
	}

	/**
	 * Record which item IDs were injected into context this turn.
	 */
	recordInjection(itemIds: string[]): void {
		this.feedbackTracker.recordInjection(itemIds);
	}

	/**
	 * Record that the agent referenced a specific memory item.
	 */
	recordReference(itemId: string): void {
		this.feedbackTracker.recordReference(itemId);
	}

	/**
	 * End-of-turn feedback: update used/ignored counts and return result.
	 */
	endTurnFeedback(): FeedbackResult {
		return this.feedbackTracker.endTurn(this.manager.getCache());
	}

	/**
	 * Signal task success: boost used memories' cognitiveWeight, penalize unused.
	 */
	signalTaskSuccess(): void {
		const result = this.feedbackTracker.endTurn(this.manager.getCache());
		const allInjected = [...result.used, ...result.ignored];
		applyTaskSuccessSignal(this.manager.getCache(), result.used, allInjected);
	}

	/**
	 * Run pattern learning if enough time has passed and enough hydration events exist.
	 * Persists newly learned triggers to the cache for reuse across sessions.
	 */
	async maybeLearn(): Promise<void> {
		const now = Date.now();
		if (now - this.lastLearnTime < this.learningConfig.intervalMs) return;

		const events = this.manager.getCache().getRecentHydrations(1000);
		if (events.length < this.learningConfig.minHydrations) return;

		this.lastLearnTime = now;

		const patterns = analyzePatterns(events, this.manager.getCache(), this.triggers);

		for (const pattern of patterns) {
			const trigger = patternToTrigger(pattern, new Set(this.triggers.map((t) => t.id)));
			this.triggers.push(trigger);
			this.manager.getCache().persistTrigger(trigger);
		}
	}

	/**
	 * Select the most relevant context items for the current turn, packed into the given token budget.
	 * Defaults to (maxTokens - reserveTokens) if budget is not provided.
	 */
	selectContextForTurn(context: TurnContext, budget?: number): SelectionResult {
		const cfg = this.manager.getConfig();
		const effectiveBudget = budget ?? cfg.maxTokens - cfg.reserveTokens;
		return selectForTurn(this.manager.getCache(), context, effectiveBudget);
	}

	/**
	 * Import context items from a child subagent's database.
	 * Opens the child DB read-only, deduplicates by content_hash, and imports
	 * items with provenance tags.
	 *
	 * @param childDbPath Path to the child's warm cache DB
	 * @param options Import options (tag, transferWeights, sessionId)
	 * @returns Import result with counts
	 */
	async importFromDb(childDbPath: string, options: ImportOptions = {}): Promise<ImportResult> {
		if (!existsSync(childDbPath)) {
			return { imported: 0, skipped: 0 };
		}

		const { tag, transferWeights = true, sessionId } = options;
		const parentCache = this.manager.getCache();

		// Open child DB (not read-only to ensure WAL data is accessible)
		// We use a separate connection so we don't interfere with any active connections
		let childDb: InstanceType<typeof Database>;
		try {
			childDb = new Database(childDbPath);
			// Checkpoint WAL to ensure all data is visible
			childDb.pragma("wal_checkpoint(TRUNCATE)");
		} catch (err) {
			console.error(`[veil] Failed to open child DB: ${err}`);
			return { imported: 0, skipped: 0 };
		}

		let imported = 0;
		let skipped = 0;

		try {
			// Check if items table exists
			const tableCheck = childDb
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='items'")
				.get() as { name: string } | undefined;
			if (!tableCheck) {
				return { imported: 0, skipped: 0 };
			}

			// Read all items from child DB
			const rows = childDb.prepare("SELECT * FROM items").all() as Array<{
				id: string;
				content: string;
				content_hash: string;
				created_at: number;
				last_access: number;
				access_count: number;
				decay_score: number;
				cognitive_weight: number;
				stability: number;
				difficulty: number;
				type: string;
				tags: string;
				pinned: number;
				kg_pointer: string | null;
				depends_on: string | null;
				valid_from: number | null;
				valid_until: number | null;
				source: string;
				source_tool_call_id: string | null;
			}>;

			for (const row of rows) {
				// Check if parent already has this item by content_hash
				const existing = parentCache.getByHash(row.content_hash);
				if (existing) {
					// Optionally transfer cognitive weight from child
					if (transferWeights && row.cognitive_weight !== 0) {
						parentCache.updateCognitiveWeight(existing.id, row.cognitive_weight * 0.5);
					}
					skipped++;
					continue;
				}

				// Parse and augment tags with provenance
				let tags: string[] = [];
				try {
					tags = JSON.parse(row.tags);
				} catch {
					tags = [];
				}

				// Add provenance tags
				if (tag) {
					tags.push(`veil:subagent=${tag}`);
				}
				if (sessionId) {
					tags.push(`veil:child-session=${sessionId}`);
				}

				// Create item for parent cache
				const item: ContextItem = {
					id: `imported_${row.content_hash}_${Date.now()}`,
					content: row.content,
					contentHash: row.content_hash,
					createdAt: row.created_at,
					lastAccess: Date.now(),
					accessCount: 1,
					usedCount: 0,
					ignoredCount: 0,
					decayScore: row.decay_score,
					cognitiveWeight: transferWeights ? row.cognitive_weight : 0,
					stability: row.stability ?? 0.5,
					difficulty: row.difficulty ?? 0.5,
					type: row.type as ContextItem["type"],
					tags,
					pinned: false,
					source: "auto",
					kgPointer: row.kg_pointer ?? undefined,
					dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
				};

				parentCache.put(item);
				imported++;
			}
		} finally {
			childDb.close();
		}

		return { imported, skipped };
	}

	/**
	 * Fork this harness to create a child harness for a subagent.
	 * The child gets its own hot tier but can read parent's warm cache.
	 *
	 * @param options Fork configuration
	 * @returns ForkResult with the child harness and metadata
	 */
	fork(options: ForkOptions): ForkResult {
		const parentConfig = this.manager.getConfig();
		const parentDbPath = parentConfig.dbPath;

		// Generate unique child session ID
		const childSessionId = `${this.sessionId ?? "session"}:${options.tagPrefix}:${Date.now()}`;
		const safeDbName = childSessionId.replace(/[^a-zA-Z0-9]/g, "_");

		// Create child DB in .children directory
		const childrenDir = `${parentDbPath}.children`;
		if (!existsSync(childrenDir)) {
			mkdirSync(childrenDir, { recursive: true });
		}
		const childDbPath = join(childrenDir, `${safeDbName}.db`);

		// Build child config
		const childConfig: VeilHarnessConfig = {
			...this.config,
			dbPath: childDbPath,
			sessionId: childSessionId,
			tagPrefix: options.tagPrefix,
			parentDbPath: options.mode === "fork" ? parentDbPath : undefined,
			parentSessionId: this.sessionId,
			// Disable cat widget in child (parent handles UI)
			catConfig: { enabled: false },
			// Don't archive turns in child (parent handles archiving)
			archivePath: undefined,
		};

		const childHarness = new VeilHarness(childConfig);

		return {
			harness: childHarness,
			dbPath: childDbPath,
			sessionId: childSessionId,
		};
	}

	/**
	 * Merge captures from a child harness back into this parent.
	 * Handles deduplication, conflict resolution, and provenance tracking.
	 *
	 * @param child The child harness to merge from
	 * @param options Merge configuration
	 * @returns MergeResult with import statistics
	 */
	async merge(child: VeilHarness, options: MergeOptions = {}): Promise<MergeResult> {
		const childConfig = child.manager.getConfig();
		const childDbPath = childConfig.dbPath;
		const childSessionId = child.getSessionId() ?? "unknown";
		const childTagPrefix = child.getTagPrefix();

		// Flush any pending captures in child before merging
		child.flushPendingCaptures();

		// Use importFromDb with enhanced options
		const importResult = await this.importFromDb(childDbPath, {
			tag: childTagPrefix,
			transferWeights: options.transferWeights ?? true,
			sessionId: childSessionId,
		});

		return {
			imported: importResult.imported,
			skipped: importResult.skipped,
			childSession: childSessionId,
		};
	}

	/**
	 * Clean up child harness resources.
	 * Call this after merge() completes to remove temporary databases.
	 *
	 * @param keepOnChanges If true, keep DB if items were captured (default: false)
	 */
	async cleanup(keepOnChanges = false): Promise<void> {
		if (!this.isChildMode) return;

		const config = this.manager.getConfig();
		const dbPath = config.dbPath;

		// Close connections first
		await this.close();

		// Check if we should keep the DB
		if (keepOnChanges) {
			// Check if any items were captured
			// DB is already closed, so we'd need to reopen - skip for now
			// In practice, the parent decides via merge() result
		}

		// Remove child DB files
		try {
			if (existsSync(dbPath)) {
				rmSync(dbPath, { force: true });
				rmSync(`${dbPath}-shm`, { force: true });
				rmSync(`${dbPath}-wal`, { force: true });
			}
		} catch {
			// Non-fatal, may already be cleaned up
		}
	}

	/**
	 * Close all connections and clean up event subscriptions.
	 */
	async close() {
		this.flushPendingCaptures();
		this.unsubscribe?.();
		this.ipcClient?.close();
		this.conversationArchive?.close();
		return this.manager.close();
	}
}
