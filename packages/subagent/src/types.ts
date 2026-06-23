/**
 * Shared types for subagent package
 */

// === Context Options ===

export interface SubagentContextOptions {
	/** Read parent's warm cache (default: true) */
	inheritWarm?: boolean;
	/** Writes go to child's DB (default: true) */
	isolateCaptures?: boolean;
	/** Tag prefix for captures, e.g. 'scout', 'reviewer' */
	tag: string;
	/** Register veil_* tools in child (default: true) */
	enableVeilTools?: boolean;
	/** Limit inherited warm items (default: 100) */
	maxWarmInherit?: number;
}

export interface SubagentContext {
	/** Session ID: parent:tag:timestamp */
	sessionId: string;
	/** Path to parent's warm cache DB */
	parentDbPath: string;
	/** Path to child's isolated warm cache DB */
	childDbPath: string;
	/** IPC socket path */
	ipcPath: string;
	/** Tag prefix */
	tag: string;
	/** Remove child DB after merge */
	cleanup(): Promise<void>;
}

export interface MergeOptions {
	/** Transfer cognitive weights from child (default: true) */
	transferWeights?: boolean;
}

export interface MergeResult {
	/** Number of items imported */
	imported: number;
	/** Number of items skipped (duplicates) */
	skipped: number;
	/** Child session ID */
	childSession: string;
}

// === IPC Protocol ===

export const IPC_VERSION = 1 as const;

export type ParentMessage =
	| { version: 1; type: "ping" }
	| { version: 1; type: "interrupt" }
	| { version: 1; type: "resume" }
	| { version: 1; type: "redirect"; task: string }
	| { version: 1; type: "abort"; reason?: string }
	| { version: 1; type: "respond"; requestId: string; answer: string }
	| { version: 1; type: "config"; key: string; value: unknown };

export type ChildMessage =
	| { version: 1; type: "pong" }
	| { version: 1; type: "ready" }
	| { version: 1; type: "escalate"; requestId: string; question: string }
	| { version: 1; type: "checkpoint"; turn: number; tokens: number; timestamp: number; lastTool?: string }
	| { version: 1; type: "progress"; message: string; percent?: number }
	| { version: 1; type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
	| { version: 1; type: "complete"; result: string }
	| { version: 1; type: "error"; message: string };

export type IpcMessage = ParentMessage | ChildMessage;

// === Agent Discovery ===

export type AgentScope = "user" | "project" | "both";
export type PromptMode = "append" | "replace";
export type ThinkingLevel = "none" | "brief" | "verbose";
export type MemoryScope = "user" | "project" | "local";
export type IsolationMode = "worktree";

// Built-in tool names that can be specified in tools: field
export const BUILTIN_TOOL_NAMES = [
	// Core tools
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	// Veil tools for subagents (no destructive ops: pin/unpin/forget/resolve_conflict)
	"veil_recall",
	"veil_remember",
	"veil_promote",
	"veil_demote",
	"veil_hydrate",
	"veil_history",
	"veil_turn_meta",
	"veil_conflicts", // can view conflicts but not resolve
] as const;

export interface AgentConfig {
	name: string;
	/** Display name shown in UI */
	displayName?: string;
	description: string;
	/** Allowed built-in tools (omit = all, empty = none) */
	builtinToolNames?: string[];
	/** Extension tool selectors like "ext:mcp__foo" */
	extSelectors?: string[];
	/** Explicitly disallowed tools */
	disallowedTools?: string[];
	/** Load extensions: true = all, false = none, string[] = named */
	extensions?: true | false | string[];
	/** Exclude specific extensions */
	excludeExtensions?: string[];
	/** Load skills: true = all, false = none, string[] = named */
	skills?: true | false | string[];
	/** Model override (provider/model format) */
	model?: string;
	/** Thinking level */
	thinking?: ThinkingLevel;
	/** Max conversation turns (0 = unlimited) */
	maxTurns?: number;
	/** System prompt content */
	systemPrompt: string;
	/** How to combine with parent prompt */
	promptMode?: PromptMode;
	/** Inherit parent's conversation context */
	inheritContext?: boolean;
	/** Run in background */
	runInBackground?: boolean;
	/** Isolated execution */
	isolated?: boolean;
	/** Memory scope */
	memory?: MemoryScope;
	/** Isolation mode */
	isolation?: IsolationMode;
	/** Agent enabled (default true) */
	enabled?: boolean;
	/** Source location */
	source: "user" | "project" | "builtin";
	filePath: string;
	/** Is a default agent */
	isDefault?: boolean;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

// === Provenance ===

export interface SubagentProvenance {
	source: string;
	parentSession: string;
	childSession: string;
	capturedAt: number;
	status: "complete" | "partial";
}
