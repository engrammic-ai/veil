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

export interface ContextWindow {
	items: ContextItem[];
	budget: ContextBudget;
}

export interface ContextManagerConfig {
	maxTokens: number;
	reserveTokens: number;
	evictionThreshold: number; // score below this triggers eviction
	decayHalfLifeHours: number;
	checkpointIntervalTurns: number;
	dbPath: string;
}

export const DEFAULT_CONFIG: ContextManagerConfig = {
	maxTokens: 128000,
	reserveTokens: 16384,
	evictionThreshold: 0.3,
	decayHalfLifeHours: 24,
	checkpointIntervalTurns: 10,
	dbPath: ".veil/context.db",
};
