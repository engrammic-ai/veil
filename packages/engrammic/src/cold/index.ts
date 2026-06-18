/**
 * Cold storage adapters for Veil.
 *
 * Default: SqliteColdStore (zero config, just works)
 *
 * Available adapters:
 * - SqliteColdStore      - Local SQLite, no external deps
 * - VeilMemoryColdStore  - FSRS decay, semantic search, conflicts (recommended)
 * - MemoryColdStore      - In-memory, for testing
 * - ZepColdStore         - Zep/Graphiti (requires @getzep/zep-cloud)
 * - LanceDBColdStore     - LanceDB vectors (requires @lancedb/lancedb)
 * - ChromaColdStore      - Chroma vectors (requires chromadb)
 *
 * Coming soon:
 * - EngrammicColdStore - Full Engrammic KG
 * - Mem0ColdStore     - Mem0 backend
 */

export { ChromaColdStore, type ChromaColdStoreConfig } from "./chroma.ts";
export * from "./interface.ts";
export { LanceDBColdStore, type LanceDBColdStoreConfig } from "./lancedb.ts";
export { MemoryColdStore } from "./memory.ts";
// Core adapters (no external deps)
// Default export
export { SqliteColdStore, SqliteColdStore as default, type SqliteColdStoreConfig } from "./sqlite.ts";
// Veil-memory adapter (FSRS, semantic search, conflicts)
export { VeilMemoryColdStore, type VeilMemoryColdStoreConfig } from "./veil-memory.ts";
// Vector store adapters (peer deps required)
export { ZepColdStore, type ZepColdStoreConfig } from "./zep.ts";
