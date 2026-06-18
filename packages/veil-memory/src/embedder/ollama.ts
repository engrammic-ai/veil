/**
 * Ollama embedder using nomic-embed-text.
 */

import type { Embedder } from "./index.ts";

export interface OllamaConfig {
	baseUrl: string;
	model: string;
}

const DEFAULT_CONFIG: OllamaConfig = {
	baseUrl: "http://localhost:11434",
	model: "nomic-embed-text",
};

export class OllamaEmbedder implements Embedder {
	readonly dimensions = 768;
	private config: OllamaConfig;

	constructor(config: Partial<OllamaConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	async healthCheck(): Promise<boolean> {
		try {
			const res = await fetch(`${this.config.baseUrl}/api/tags`);
			if (!res.ok) return false;
			const data = (await res.json()) as { models?: Array<{ name: string }> };
			return data.models?.some((m) => m.name.startsWith(this.config.model)) ?? false;
		} catch {
			return false;
		}
	}

	async embed(text: string): Promise<Float32Array> {
		const res = await fetch(`${this.config.baseUrl}/api/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.config.model,
				prompt: text,
			}),
		});

		if (!res.ok) {
			throw new Error(`Ollama embedding failed: ${res.status} ${res.statusText}`);
		}

		const data = (await res.json()) as { embedding: number[] };
		return new Float32Array(data.embedding);
	}
}
