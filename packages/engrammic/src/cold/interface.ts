/**
 * ColdStore interface - abstraction for long-term memory backends.
 *
 * Veil uses this to demote items from warm cache to cold storage,
 * and to fetch them back when needed. Separate from MCP tools
 * (which agents use directly).
 */

import type { ContextItem } from "../types.ts";

export interface ColdStoreCapabilities {
	semantic: boolean; // can do similarity search
	temporal: boolean; // tracks valid_time / system_time
	provenance: boolean; // tracks source/evidence chains
}

export interface ColdStore {
	/**
	 * Demote an item from warm cache to cold storage.
	 * Returns a pointer (ID) that can be used to fetch it later.
	 */
	demote(item: ContextItem): Promise<string>;

	/**
	 * Fetch an item from cold storage by its pointer.
	 * Returns null if not found or tombstoned.
	 */
	fetch(pointer: string): Promise<ContextItem | null>;

	/**
	 * Delete an item from cold storage permanently.
	 */
	delete(pointer: string): Promise<void>;

	/**
	 * Check if an item exists in cold storage.
	 */
	exists(pointer: string): Promise<boolean>;

	/**
	 * Get total count of items in cold storage.
	 */
	count(): Promise<number>;

	/**
	 * Optional: Query cold storage by text/tags.
	 * Only available if capabilities.semantic is true.
	 */
	query?(text: string, tags: string[], limit: number): Promise<ContextItem[]>;

	/**
	 * What this cold store supports.
	 */
	readonly capabilities: ColdStoreCapabilities;

	/**
	 * Close any connections. Called on shutdown.
	 */
	close(): Promise<void>;
}

export interface ColdStoreConfig {
	// Common config across adapters
	namespace?: string; // isolate data per agent/project
}
