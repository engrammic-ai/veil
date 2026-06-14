/**
 * Core types for Veil context management
 */

export interface ContextItem {
	id: string;
	content: string;
	contentHash: string;

	// Access tracking
	createdAt: number;
	lastAccess: number;
	accessCount: number;

	// Scoring
	decayScore: number;
	cognitiveWeight: number; // -1 to +1, success/failure attribution

	// Classification
	type: "episodic" | "procedural" | "fact";
	tags: string[];
	pinned: boolean;

	// Storage linkage
	kgPointer?: string; // node ID in cold storage
	dependsOn?: string[]; // IDs of items this depends on

	// Bi-temporal
	validFrom?: number; // when true in world (e.g., git commit time)
	validUntil?: number; // null if still valid

	// Source tracking
	source: "auto" | "explicit"; // auto-captured vs explicitly remembered
	sourceToolCallId?: string; // links to Pi tool call for faded history
}

export interface TaskContext {
	tags: string[];
	currentFile?: string;
	recentSymbols?: string[];
}

export interface ContextBudget {
	maxTokens: number;
	usedTokens: number;
	reserveTokens: number; // headroom to keep free
}

export interface EvictionCandidate {
	item: ContextItem;
	score: number;
	reason: "age" | "low_score" | "budget" | "manual";
}

export interface EvictionNotifyConfig {
	enabled: boolean;
	minItems: number;
	verbosity: "minimal" | "standard" | "verbose";
}

export const DEFAULT_EVICTION_NOTIFY_CONFIG: EvictionNotifyConfig = {
	enabled: false,
	minItems: 3,
	verbosity: "minimal",
};

export interface ContextWindow {
	items: ContextItem[];
	budget: ContextBudget;
}

export interface ContextManagerConfig {
	maxTokens: number;
	reserveTokens: number;
	evictionThreshold: number; // score below this triggers eviction
	evictionThresholdMin: number;
	evictionThresholdMax: number;
	evictionThresholdDefault: number;
	decayHalfLifeHours: number;
	checkpointIntervalTurns: number;
	recallCooldownTurns: number;
	maxItemBudgetRatio: number;
	warmCacheMaxItems: number;
	coldFailureThreshold: number;
	coldCircuitResetMs: number;
	dbPath: string;
	// UX
	statusBarEnabled: boolean;
	fadeEvicted: boolean;
	evictionNotify: EvictionNotifyConfig;
}

export interface CaptureRule {
	type: "episodic" | "fact";
	tags: string[];
}

export interface CaptureConfig {
	maxItemsPerTurn: number;
	maxItemsPerSession: number;
	minChars: number;
	maxChars: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
	maxItemsPerTurn: 10,
	maxItemsPerSession: 500,
	minChars: 50,
	maxChars: 8000,
};

export const DEFAULT_CONFIG: ContextManagerConfig = {
	maxTokens: 128000,
	reserveTokens: 16384,
	evictionThreshold: 0.3,
	evictionThresholdMin: 0.6,
	evictionThresholdMax: 0.85,
	evictionThresholdDefault: 0.7,
	decayHalfLifeHours: 24,
	checkpointIntervalTurns: 10,
	recallCooldownTurns: 5,
	maxItemBudgetRatio: 0.2,
	warmCacheMaxItems: 1000,
	coldFailureThreshold: 3,
	coldCircuitResetMs: 300000,
	dbPath: ".veil/context.db",
	// UX
	statusBarEnabled: true,
	fadeEvicted: true,
	evictionNotify: DEFAULT_EVICTION_NOTIFY_CONFIG,
};
