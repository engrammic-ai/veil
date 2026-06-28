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

	// Feedback tracking
	usedCount: number; // times agent referenced after injection
	ignoredCount: number; // times injected but not referenced

	// Scoring
	decayScore: number;
	cognitiveWeight: number; // -1 to +1, success/failure attribution

	// FSRS parameters
	stability: number; // days until R drops to 0.9
	difficulty: number; // 0.1-0.9, how hard to remember

	// Classification
	type: ContextItemType;
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
	sourceToolName?: string; // tool that produced this (Read, Bash, etc.)
	sourcePath?: string; // file path if from file read
	sourceSessionId?: string; // session where this was captured

	// Staleness tracking
	resourceMtime?: number; // mtime (ms) of referenced file when captured
	resourceHash?: string; // sha256 prefix of file content when captured
	isStale?: boolean; // set on recall if the referenced resource changed
}

// Type alias extracted from ContextItem for reuse
export type ContextItemType = "episodic" | "procedural" | "fact" | "decision" | "intent";

// Trigger for pattern matching user messages (anticipatory loading)
export interface Trigger {
	id: string;
	pattern: RegExp;
	negative?: RegExp; // If matches, trigger doesn't fire
	type: "keyword" | "file" | "command";
	action: {
		tags?: string[];
		type?: ContextItemType;
	};
	priority: number; // Higher = checked first
	enabled: boolean;
	learned?: boolean;
	confidence?: number;
}

// Manifest item shown to agent (lightweight summary)
export interface ManifestItem {
	id: string;
	type: ContextItemType;
	tags: string[];
	summary: string; // First 50 chars
	age: string; // "2min ago", "1hr ago"
	source?: "warm" | "cold";
}

// Full manifest returned by anticipatory loading
export interface ContextManifest {
	triggers: string[]; // Trigger IDs that fired
	budgetPercent: number; // Budget at query time (pre-preload)
	items: ManifestItem[]; // Max 10
}

// Cold surfacing result item
export interface SurfacedItem {
	item: ManifestItem;
	confidence: number; // 0-1, from cognitiveWeight/priority
}

// Summary of surfacing operation
export interface SurfacingResult {
	loaded: string[]; // IDs auto-loaded (confidence > 0.8)
	stubs: ManifestItem[]; // medium confidence (0.5-0.8)
	conflicts: number; // engrammic conflicts count
}

export interface TurnMeta {
	type: "decision" | "exploration" | "action" | "correction" | "status" | "intent";
	intentId?: string;
	decisionSummary?: string;
	turnNumber?: number; // filled in by harness
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
	reason: "age" | "low_score" | "budget" | "manual" | "context_pressure";
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

// Conflict tracking with provenance for LLM resolution
export interface BeliefProvenance {
	eventId: string;
	content: string;
	confidence: number;
	sourceTier: "authoritative" | "validated" | "observed" | "inferred";
	sourceToolName?: string;
	sourcePath?: string;
	sessionId?: string;
	recordedAt: number;
}

export interface PendingConflict {
	id: string; // conflict ID for tracking
	subject: string; // what the conflict is about
	beliefA: BeliefProvenance;
	beliefB: BeliefProvenance;
	similarity: number; // semantic similarity score
	detectedAt: number;
	suggestion?: string; // hint for resolution
}

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
	// Autonomic self-tuning
	reRequestBackoffStep: number; // threshold raise per re-request miss (AIMD back-off)
	reRequestWindowMs: number; // how recently an item must have been evicted to count a re-capture as a miss
	decaySweepIntervalTurns: number; // run decay sweep every N ticks
	// UX
	statusBarEnabled: boolean;
	fadeEvicted: boolean;
	evictionNotify: EvictionNotifyConfig;
	// Worldview (Phase C)
	enableWorldview: boolean;
}

export interface CaptureRule {
	type: ContextItemType;
	tags: string[];
}

export interface CaptureConfig {
	maxItemsPerTurn: number;
	maxItemsPerSession: number;
	minChars: number;
	maxChars: number;
	maxTokenBudget: number; // Hard cap in tokens (default: 8000)
	softThresholdPercent: number; // Fraction at which warning emits (default: 0.75)
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
	maxItemsPerTurn: 10,
	maxItemsPerSession: 500,
	minChars: 50,
	maxChars: 8000,
	maxTokenBudget: 8000,
	softThresholdPercent: 0.75,
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
	// Autonomic self-tuning
	reRequestBackoffStep: 0.05,
	reRequestWindowMs: 30 * 60 * 1000,
	decaySweepIntervalTurns: 50,
	// UX
	statusBarEnabled: true,
	fadeEvicted: true,
	evictionNotify: DEFAULT_EVICTION_NOTIFY_CONFIG,
	// Worldview (Phase C)
	enableWorldview: false, // opt-in for now; requires tree-sitter WASM
};
