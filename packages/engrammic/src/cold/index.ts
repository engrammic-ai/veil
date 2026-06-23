/**
 * Cold storage adapters for Veil.
 *
 * Available adapters:
 * - VeilMemoryColdStore  - FSRS decay, semantic search, conflicts (default, recommended)
 * - MockColdStore        - In-memory, for testing only
 */

export * from "./interface.ts";
export { MockColdStore } from "./mock.ts";
export { VeilMemoryColdStore, VeilMemoryColdStore as default, type VeilMemoryColdStoreConfig } from "./veil-memory.ts";
