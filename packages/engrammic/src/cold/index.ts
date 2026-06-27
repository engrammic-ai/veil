/**
 * Cold storage adapters for Veil.
 *
 * Available adapters:
 * - VeilMemoryColdStore  - FSRS decay, semantic search, conflicts (default, recommended)
 * - EngrammicColdStore   - engrammic MCP adapter, cross-project/cross-device
 * - MockColdStore        - In-memory, for testing only
 */

export {
	type ConflictInfo,
	EngrammicColdStore,
	type EngrammicColdStoreConfig,
	EngrammicUnavailableError,
	type McpExecutor,
	type TraceResult,
} from "./engrammic.ts";
export * from "./interface.ts";
export { MockColdStore } from "./mock.ts";
export { VeilMemoryColdStore, VeilMemoryColdStore as default, type VeilMemoryColdStoreConfig } from "./veil-memory.ts";
