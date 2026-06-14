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

import { hashContent } from "./cache.ts";
import { extractContent, generateInternalTags, getCaptureRule } from "./capture.ts";
import type { ColdStore } from "./cold/interface.ts";
import { detectStubs, formatHydratedBlock, hydrateStub } from "./hydration.ts";
import { buildContextSection } from "./injection.ts";
import { ContextManager } from "./manager.ts";
import { rankItems } from "./scorer.ts";
import { executeVeilTool, TOOL_SCHEMAS, type ToolDefinition, type ToolResult } from "./tools.ts";
import type { CaptureConfig, ContextManagerConfig, EvictionCandidate, TaskContext } from "./types.ts";
import { DEFAULT_CAPTURE_CONFIG } from "./types.ts";
import { estimateTokens, smartTruncate } from "./utils.ts";
import { buildManifest, DEFAULT_TRIGGERS, formatManifest, matchTriggers } from "./anticipate.ts";
import type { ContextManifest, Trigger } from "./types.ts";

export interface VeilHarnessConfig extends Partial<ContextManagerConfig> {
	coldStore?: ColdStore;
	onEviction?: (evicted: EvictionCandidate[]) => void;
	onCheckpoint?: (turnCount: number) => void;
	sessionId?: string; // Tag context items with session
	captureConfig?: Partial<CaptureConfig>;
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
	private manifestItemIds: Set<string> = new Set();  // For Phase 6 learning

	constructor(config: VeilHarnessConfig = {}) {
		this.config = config;
		this.sessionId = config.sessionId;
		this.captureConfig = { ...DEFAULT_CAPTURE_CONFIG, ...config.captureConfig };
		this.manager = new ContextManager(config, config.coldStore);
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
			}
			if (this.config.onEviction) {
				this.config.onEviction(evicted);
			}
		}

		// Don't block any tool calls - just manage context
		return undefined;
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
		if (event.isError) return;
		this.autoCapture(event.toolName, event.input, event.content, event.toolCallId);
	}

	/**
	 * Auto-capture a tool result into the warm cache, respecting rate limits and deduplication.
	 */
	private autoCapture(
		toolName: string,
		args: unknown,
		content: Array<{ type: string; text?: string }>,
		toolCallId?: string,
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

		// Truncate if needed
		const truncated = smartTruncate(text, this.captureConfig.maxChars);

		// Check for duplicates — use the same hash function as createItem (cache.ts)
		const hash = hashContent(truncated);
		const existing = this.manager.getCache().getByHash(hash);
		if (existing) {
			this.manager.getCache().touch(existing.id);
			return;
		}

		// Generate tags
		const tags = [...rule.tags, ...generateInternalTags(toolName, args)];

		// Store in warm cache with tool call ID for faded history
		this.manager.remember(truncated, rule.type, tags, toolCallId);
		this.capturesThisTurn++;
		this.totalCaptures++;
	}

	/**
	 * Reset per-turn capture counter. Call at turn boundaries.
	 */
	resetTurnCaptures(): void {
		this.capturesThisTurn = 0;
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
	 * Remember something (store in warm cache).
	 */
	remember(content: string, type: "episodic" | "procedural" | "fact", tags: string[] = [], toolCallId?: string) {
		return this.manager.remember(content, type, tags, toolCallId);
	}

	/**
	 * Recall items by tags.
	 */
	recall(tags: string[], limit = 10) {
		return this.manager.recall(tags, limit);
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
		return executeVeilTool(name, params, { manager: this.manager });
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
		const triggers = matchTriggers(message, this.triggers);
		if (triggers.length === 0) return null;

		const budget = this.getUsage();
		if (budget.percent > 70) return null;

		let manifest: ContextManifest | null;
		try {
			manifest = await buildManifest(triggers, this.manager.getCache(), { percent: budget.percent });
		} catch (err) {
			// Log error, don't block agent flow
			console.error("[veil] manifest build failed:", err);
			return null;
		}

		if (!manifest) return null;

		// Track for Phase 6 learning
		this.trackManifestItems(manifest);

		// Eager preload if budget allows
		if (budget.percent < 50) {
			this.preloadTopItems(manifest, 3);
		}

		return formatManifest(manifest);
	}

	/**
	 * Track manifest items for future learning (Phase 6).
	 */
	private trackManifestItems(manifest: ContextManifest): void {
		this.manifestItemIds.clear();
		for (const item of manifest.items) {
			this.manifestItemIds.add(item.id);
		}
	}

	/**
	 * Preload top N manifest items into hot context.
	 */
	private preloadTopItems(manifest: ContextManifest, limit: number): void {
		const ids = manifest.items.slice(0, limit).map(i => i.id);
		this.load(ids);  // Existing method, handles dedup
	}

	/**
	 * Check if an item ID was in the last manifest (for Phase 6 learning).
	 */
	wasInManifest(id: string): boolean {
		return this.manifestItemIds.has(id);
	}

	/**
	 * Close all connections and clean up event subscriptions.
	 */
	async close() {
		this.unsubscribe?.();
		return this.manager.close();
	}
}
