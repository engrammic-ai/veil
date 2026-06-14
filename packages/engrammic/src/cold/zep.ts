/**
 * Zep/Graphiti ColdStore adapter.
 *
 * Requires: @getzep/zep-js (peer dependency)
 *
 * Zep's Graphiti provides temporal knowledge graphs - good fit for
 * bi-temporal tracking.
 */

import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export interface ZepColdStoreConfig extends ColdStoreConfig {
	apiUrl?: string;
	apiKey?: string;
}

export class ZepColdStore implements ColdStore {
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // Zep has embeddings
		temporal: true, // Graphiti tracks time
		provenance: false,
	};

	constructor(config: ZepColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		try {
			// const { ZepClient } = require('@getzep/zep-cloud')
			// this.client = new ZepClient({ apiKey: config.apiKey })
			throw new Error("Zep integration pending");
		} catch {
			throw new Error("ZepColdStore requires @getzep/zep-cloud. Install: pnpm add @getzep/zep-cloud");
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
		throw new Error("Not implemented");
	}

	async close(): Promise<void> {}
}
