/**
 * LanceDB ColdStore adapter.
 *
 * Requires: lancedb (peer dependency)
 *
 * LanceDB is an embedded vector database - no server needed.
 * Good for local-first with semantic search.
 */

import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export interface LanceDBColdStoreConfig extends ColdStoreConfig {
	dbPath: string;
	embeddingModel?: string; // e.g., 'all-MiniLM-L6-v2'
}

export class LanceDBColdStore implements ColdStore {
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // Vector search
		temporal: false,
		provenance: false,
	};

	constructor(config: LanceDBColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		try {
			// const lancedb = require('@lancedb/lancedb')
			// this.db = await lancedb.connect(config.dbPath)
			throw new Error("LanceDB integration pending");
		} catch {
			throw new Error("LanceDBColdStore requires @lancedb/lancedb. Install: pnpm add @lancedb/lancedb");
		}
	}

	async demote(_item: ContextItem): Promise<string> {
		throw new Error("Not implemented");
	}

	async fetch(_pointer: string): Promise<ContextItem | null> {
		throw new Error("Not implemented");
	}

	async delete(_pointer: string): Promise<void> {
		throw new Error("Not implemented");
	}

	async exists(_pointer: string): Promise<boolean> {
		throw new Error("Not implemented");
	}

	async count(): Promise<number> {
		throw new Error("Not implemented");
	}

	async query(_text: string, _tags: string[], _limit: number): Promise<ContextItem[]> {
		// TODO: Vector similarity search
		throw new Error("Not implemented");
	}

	async close(): Promise<void> {
		// TODO: Close LanceDB connection
	}
}
