/**
 * Core types for Veil Memory companion system.
 */

export type MemoryType = "episodic" | "factual" | "procedural";
export type EventType = "assert" | "retract" | "reinforce";
export type SourceTier = "authoritative" | "validated" | "observed" | "inferred";

export type VersionVector = Record<string, number>;

export interface MemoryEvent {
	eventId: string;
	namespace: string;
	eventType: EventType;
	agentId: string;
	content: string;
	contentHash: string;
	memoryType: MemoryType;
	subject?: string;
	subjectHash?: string;
	versionVector: VersionVector;
	confidence: number;
	evidenceCount: number;
	validFrom: number;
	recordedAt: number;
	difficulty: number;
	stability: number;
	embeddingModel: string;
	sourceTier: SourceTier;
	tags: string[];
}

export interface CurrentBelief {
	eventId: string;
	namespace: string;
	content: string;
	memoryType: MemoryType;
	subject?: string;
	subjectHash?: string;
	confidence: number;
	validFrom: number;
	recordedAt: number;
	difficulty: number;
	stability: number;
	retrievability: number;
	lastRecall?: number;
	recallCount: number;
	hasConflicts: boolean;
	conflictEventIds?: string[];
}

export interface MemoryStub {
	id: string;
	summary: string;
	subject?: string;
	memoryType: MemoryType;
	retrievability: number;
	age: string;
}

export interface ConflictPair {
	subjectHash: string;
	eventIdA: string;
	eventIdB: string;
	contentA: string;
	contentB: string;
	agentA: string;
	agentB: string;
	confidenceA: number;
	confidenceB: number;
	recordedAtA: number;
	recordedAtB: number;
}

export type ConflictStrategy = "confidence" | "latest" | "judge" | "keep_both";

export interface ConflictResolutionConfig {
	strategy: ConflictStrategy;
	confidenceThreshold: number;
}

export interface RecallOptions {
	namespace?: string;
	types?: MemoryType[];
	limit?: number;
	minRetrievability?: number;
	includeCold?: boolean;
}

export interface LearnOptions {
	namespace?: string;
	confidence?: number;
	evidenceCount?: number;
	sourceTier?: SourceTier;
	tags?: string[];
}

export interface RememberOptions {
	namespace?: string;
	tags?: string[];
	sourceTier?: SourceTier;
}

export interface CatState {
	state: "sleeping" | "watching" | "remembering" | "learned" | "recalled" | "conflict";
	detail?: string;
}

export interface CatConfig {
	enabled: boolean;
	position: "statusbar" | "inline" | "off";
	mode: "unicode" | "ascii" | "auto";
	minimal: boolean;
}

export interface SessionStats {
	remembered: number;
	learned: number;
	recalled: number;
	stabilityAvg: number;
	conflicts: number;
	evicted: number;
}

export interface ConsolidationResult {
	updated: number;
	archived: number;
	pruned: number;
	conflicts: number;
}

export interface MemoryHealth {
	total: number;
	byType: Record<MemoryType, number>;
	avgRetrievability: number;
	conflicts: number;
	lowRCount: number;
}
