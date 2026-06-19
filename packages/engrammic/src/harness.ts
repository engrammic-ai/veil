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

import { buildManifest, DEFAULT_TRIGGERS, formatManifest, matchTriggers } from "./anticipate.ts";
import { type AttemptRecord, AttemptStore, detectFailure } from "./attempts.ts";
import { hashContent } from "./cache.ts";
import { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";
import { normalizeCapture } from "./capture-document.ts";
import { type CatConfig, CatWidget, type SessionStats } from "./cat.ts";
import type { ColdStore } from "./cold/interface.ts";
import { type ContentMetadata, compressSync } from "./compression/index.ts";
import {
	buildConvergenceWarning,
	ConvergenceMonitor,
	type ConvergenceState,
	type ConvergenceThresholds,
	type EscalationResult,
} from "./convergence.ts";
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
import { buildContextSection, buildFailureSection } from "./injection.ts";
import { CONTEXT_MANAGEMENT_PROMPT } from "./prompts.ts";
import { analyzePatterns, patternToTrigger } from "./learning.ts";
import { ContextManager } from "./manager.ts";
import { type SelectionResult, selectForTurn, type TurnContext } from "./retrieval.ts";
import { rankItems } from "./scorer.ts";
import { executeVeilTool, TOOL_SCHEMAS, type ToolDefinition, type ToolResult } from "./tools.ts";
import { handleTrigger, isDangerousCommand, type TriggerResult } from "./triggers.ts";
import type {
	CaptureConfig,
	ContextManagerConfig,
	ContextManifest,
	EvictionCandidate,
	TaskContext,
	Trigger,
} from "./types.ts";
import { DEFAULT_CAPTURE_CONFIG } from "./types.ts";
import { estimateTokens, smartTruncate } from "./utils.ts";

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
	| "conflict"
	| "sleeping"
	| "budget_exceeded"
	| "budget_warning";

export interface MemoryEvent {
	type: MemoryEventType;
	detail?: string;
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

	constructor(config: VeilHarnessConfig = {}) {
		this.config = config;
		this.sessionId = config.sessionId;
		this.captureConfig = { ...DEFAULT_CAPTURE_CONFIG, ...config.captureConfig };
		this.learningConfig = { ...this.learningConfig, ...config.learningConfig };
		this.manager = new ContextManager(config, config.coldStore);
		const customTriggers = this.manager.getCache().loadCustomTriggers();
		this.triggers = [...DEFAULT_TRIGGERS, ...customTriggers];

		// Initialize cat widget
		this.catWidget = new CatWidget(config.catConfig);

		// Phase D: Initialize failure-memory
		this.attemptStore = new AttemptStore(this.manager.getCache().getDb());
		this.goalState = createGoalInferenceState();
		this.convergenceMonitor = new ConvergenceMonitor(config.convergenceThresholds);
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
		// Emit watching event when tool starts
		this.emitMemoryEvent("watching", context.toolCall.name);

		// Update task context based on tool being called
		this.updateTaskContext(context.toolCall.name, context.args);

		// Check if eviction needed
		const evicted = await this.manager.checkEviction(this.currentTaskContext);

		if (evicted.length > 0) {
			// Track evicted tool call IDs for faded history
			for (const candidate of evicted) {
				if (candidate.item.sourceToolCallId) {
					this.evictedToolCallIds.add(candidate.item.sourceToolCallId);
				}
				// Decrement token budget only for items auto-captured by this harness
				if (this.autoCapturedIds.has(candidate.item.id)) {
					const freed = this.estimateTokens(candidate.item.content);
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
		// Record outcome for cognitive weight tracking
		const success = !context.result.isError;
		this.manager.recordOutcome(success);

		// Tick turn counter
		const isCheckpoint = this.manager.tick();
		if (isCheckpoint && this.config.onCheckpoint) {
			this.config.onCheckpoint(this.getTurnCount());
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
		const event = { type, detail };

		// Update cat widget state (only forward states the widget understands)
		const CAT_STATES = new Set(["sleeping", "watching", "remembering", "learned", "recalled", "conflict"]);
		if (CAT_STATES.has(type)) {
			this.catWidget.setState({
				state: type as "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "conflict",
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
	 */
	remember(content: string, type: "episodic" | "procedural" | "fact", tags: string[] = [], toolCallId?: string) {
		this.emitMemoryEvent("remembering", content.slice(0, 50));
		const result = this.manager.remember(content, type, tags, toolCallId);
		this.emitMemoryEvent("learned", type);
		return result;
	}

	/**
	 * Recall items by tags.
	 */
	async recall(tags: string[], limit = 10) {
		this.emitMemoryEvent("watching", `searching ${tags.join(", ")}`);
		const result = await this.manager.recall(tags, limit);
		this.emitMemoryEvent("recalled", `found ${result.length} items`);
		return result;
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
	 */
	async forget(id: string) {
		return this.manager.forget(id);
	}

	/**
	 * Fetch from cold storage.
	 */
	async fetchFromCold(pointer: string) {
		return this.manager.fetchFromCold(pointer);
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
		return executeVeilTool(name, params, { manager: this.manager, onRecall: (ids) => this.onRecall(ids) });
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
	 * Close all connections and clean up event subscriptions.
	 */
	async close() {
		this.flushPendingCaptures();
		this.unsubscribe?.();
		return this.manager.close();
	}
}
