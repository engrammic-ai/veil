/**
 * Embedder wrapper that uses the veil-embedder server.
 */

import { EmbedderClient } from "@veil/embedder";
import type { Embedder } from "../store.ts";

export class ServerEmbedder implements Embedder {
	private client: EmbedderClient;
	private _dimensions: number | null = null;

	constructor(port?: number) {
		this.client = new EmbedderClient({ port, autoStart: true });
	}

	get dimensions(): number {
		return this._dimensions ?? 768;
	}

	async embed(text: string): Promise<Float32Array> {
		const result = await this.client.embedOne(text);
		if (!result) {
			throw new Error("Embedding failed - server unavailable");
		}

		if (!this._dimensions) {
			this._dimensions = result.length;
		}

		return result;
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		const result = await this.client.embed(texts);
		if (!result) {
			throw new Error("Embedding failed - server unavailable");
		}

		if (result.length > 0 && !this._dimensions) {
			this._dimensions = result[0].length;
		}

		return result;
	}

	async isAvailable(): Promise<boolean> {
		return this.client.isRunning();
	}

	async ensureRunning(): Promise<boolean> {
		return this.client.ensureRunning();
	}
}
