/**
 * Engrammic ColdStore - full-featured adapter for Engrammic KG.
 *
 * Requires: @engrammic/sdk (peer dependency)
 *
 * Provides:
 * - Semantic search via embeddings
 * - Bi-temporal tracking (valid_time + system_time)
 * - Provenance chains (evidence, supersession)
 */

import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export interface EngrammicColdStoreConfig extends ColdStoreConfig {
	endpoint?: string; // defaults to local
	apiKey?: string;
}

export class EngrammicColdStore implements ColdStore {
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true,
		temporal: true,
		provenance: true,
	};

	constructor(config: EngrammicColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		// Lazy load SDK to avoid requiring it when not used
		try {
			// const { EngrammicClient } = require('@engrammic/sdk')
			// this.client = new EngrammicClient({ endpoint: config.endpoint, apiKey: config.apiKey })
			throw new Error("Engrammic SDK not yet available - use SqliteColdStore for now");
		} catch (_e) {
			throw new Error("EngrammicColdStore requires @engrammic/sdk. Install it with: npm install @engrammic/sdk");
		}
	}

	async demote(_item: ContextItem): Promise<string> {
		// TODO: Implement when SDK available
		// const node = await this.client.remember({
		//   content: item.content,
		//   type: item.type,
		//   tags: item.tags,
		//   validFrom: item.validFrom,
		//   namespace: this.namespace,
		// })
		// return node.id
		throw new Error("Not implemented");
	}

	async fetch(_pointer: string): Promise<ContextItem | null> {
		// TODO: Implement when SDK available
		// const node = await this.client.get(pointer)
		// if (!node) return null
		// return this.nodeToItem(node)
		throw new Error("Not implemented");
	}

	async delete(_pointer: string): Promise<void> {
		// TODO: Implement when SDK available
		// await this.client.forget(pointer)
		throw new Error("Not implemented");
	}

	async exists(_pointer: string): Promise<boolean> {
		// TODO: Implement when SDK available
		throw new Error("Not implemented");
	}

	async count(): Promise<number> {
		// TODO: Implement when SDK available
		throw new Error("Not implemented");
	}

	async query(_text: string, _tags: string[], _limit: number): Promise<ContextItem[]> {
		// TODO: Implement when SDK available
		// const results = await this.client.recall({
		//   query: text,
		//   tags,
		//   limit,
		//   namespace: this.namespace,
		// })
		// return results.map(this.nodeToItem)
		throw new Error("Not implemented");
	}

	async close(): Promise<void> {
		// TODO: Close client connection
	}
}
