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

import type { ColdStore } from "./cold/interface.ts";
import { ContextManager } from "./manager.ts";
import type { ContextManagerConfig, EvictionCandidate, TaskContext } from "./types.ts";

export interface VeilHarnessConfig extends Partial<ContextManagerConfig> {
	coldStore?: ColdStore;
	onEviction?: (evicted: EvictionCandidate[]) => void;
	onCheckpoint?: (turnCount: number) => void;
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

export class VeilHarness {
	private manager: ContextManager;
	private config: VeilHarnessConfig;
	private currentTaskContext: TaskContext = { tags: [] };

	constructor(config: VeilHarnessConfig = {}) {
		this.config = config;
		this.manager = new ContextManager(config, config.coldStore);
	}

	/**
	 * Get the underlying ContextManager for direct access.
	 */
	getManager(): ContextManager {
		return this.manager;
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

		if (evicted.length > 0 && this.config.onEviction) {
			this.config.onEviction(evicted);
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
	 * Remember something (store in warm cache).
	 */
	remember(content: string, type: "episodic" | "procedural" | "fact", tags: string[] = []) {
		return this.manager.remember(content, type, tags);
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
	 * Close all connections.
	 */
	async close() {
		return this.manager.close();
	}
}
