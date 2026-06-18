/**
 * Veil Memory: FSRS-powered memory companion for AI agents.
 */

export type { Embedder as EmbedderInterface } from "./embedder/index.ts";
export { OllamaEmbedder } from "./embedder/ollama.ts";
export { DEFAULT_FSRS_CONFIG, type FSRSConfig, FSRSEngine, type RetrievabilityTier } from "./fsrs.ts";
export { getSchemaVersion, initSchema, needsMigration, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";
export { type Embedder, MemoryStore, type StoreConfig } from "./store.ts";
export type {
	CatConfig,
	CatState,
	ConflictPair,
	ConflictResolutionConfig,
	ConflictStrategy,
	ConsolidationResult,
	CurrentBelief,
	EventType,
	LearnOptions,
	MemoryEvent,
	MemoryHealth,
	MemoryStub,
	MemoryType,
	RecallOptions,
	RememberOptions,
	SessionStats,
	SourceTier,
	VersionVector,
} from "./types.ts";
export { CatWidget, DEFAULT_CAT_CONFIG } from "./ui/cat.ts";
export { areConcurrent, compare, dominates, increment, isEmpty, merge } from "./version-vector.ts";
