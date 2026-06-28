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
	glob: boolean; // supports glob patterns in tags
	listing: boolean; // supports list() without semantic query
}

export interface ListOptions {
	/** Glob patterns allowed. Empty = no tag filter. */
	tags?: string[];
	/** Max items to return. Default: 100. */
	limit?: number;
	/** Pagination cursor from previous response. */
	cursor?: string;
	/** Sort order. Default: "recent". */
	sort?: "recent" | "oldest" | "relevance";
	/** Case-insensitive glob matching. Default: false (case-sensitive). */
	ignoreCase?: boolean;
}

export interface ListResult {
	items: ContextItem[];
	/** Pass to next list() call for pagination. Absent = no more pages. */
	nextCursor?: string;
	/** Total count if backend supports it. */
	total?: number;
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
	 * List items without semantic query.
	 * Use for browsing, "show all", or glob-filtered listing.
	 * Only available if capabilities.listing is true.
	 */
	list?(options?: ListOptions): Promise<ListResult>;

	/**
	 * Fetch all items whose ID starts with prefix.
	 * Useful for bulk operations on related items.
	 */
	fetchByPrefix?(prefix: string, limit?: number): Promise<ContextItem[]>;

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
