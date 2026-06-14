/**
 * Mem0 ColdStore adapter.
 *
 * Requires: mem0ai (peer dependency)
 */

import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export interface Mem0ColdStoreConfig extends ColdStoreConfig {
	apiKey?: string;
	orgId?: string;
	projectId?: string;
}

export class Mem0ColdStore implements ColdStore {
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // Mem0 has embeddings
		temporal: false, // No bi-temporal
		provenance: false,
	};

	constructor(config: Mem0ColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		try {
			// const { MemoryClient } = require('mem0ai')
			// this.client = new MemoryClient({ apiKey: config.apiKey })
			throw new Error("Mem0 integration pending");
		} catch {
			throw new Error("Mem0ColdStore requires mem0ai. Install it with: npm install mem0ai");
		}
	}

	async demote(_item: ContextItem): Promise<string> {
		// TODO: await this.client.add(item.content, { user_id: this.namespace, metadata: {...} })
		throw new Error("Not implemented");
	}

	async fetch(_pointer: string): Promise<ContextItem | null> {
		// TODO: await this.client.get(pointer)
		throw new Error("Not implemented");
	}

	async delete(_pointer: string): Promise<void> {
		// TODO: await this.client.delete(pointer)
		throw new Error("Not implemented");
	}

	async exists(_pointer: string): Promise<boolean> {
		throw new Error("Not implemented");
	}

	async count(): Promise<number> {
		throw new Error("Not implemented");
	}

	async query(_text: string, _tags: string[], _limit: number): Promise<ContextItem[]> {
		// TODO: await this.client.search(text, { user_id: this.namespace, limit })
		throw new Error("Not implemented");
	}

	async close(): Promise<void> {}
}
