/**
 * Chroma ColdStore adapter.
 *
 * Requires: chromadb (peer dependency)
 *
 * Chroma is a popular vector database with server mode.
 * Use for team/shared setups where multiple agents need access.
 */

import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export interface ChromaColdStoreConfig extends ColdStoreConfig {
	host?: string; // defaults to localhost:8000
	collectionName?: string;
}

export class ChromaColdStore implements ColdStore {
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // Vector search
		temporal: false,
		provenance: false,
	};

	constructor(config: ChromaColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		try {
			// const { ChromaClient } = require('chromadb')
			// this.client = new ChromaClient({ path: config.host })
			// this.collection = await this.client.getOrCreateCollection({ name: config.collectionName ?? 'veil' })
			throw new Error("Chroma integration pending");
		} catch {
			throw new Error("ChromaColdStore requires chromadb. Install: pnpm add chromadb");
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

	async close(): Promise<void> {}
}
