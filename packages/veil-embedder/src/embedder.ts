/**
 * Core embedder using transformers.js or Ollama fallback.
 */

import { MODEL_REGISTRY, type ModelSpec, type ModelTier } from "./types.ts";

export interface Embedder {
	readonly dimensions: number;
	readonly model: ModelSpec;
	embed(texts: string[]): Promise<Float32Array[]>;
	unload(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineFn: any = null;
let cacheConfigured = false;

export function configureCacheDir(cacheDir: string): void {
	if (cacheConfigured) return;
	// Will be applied when transformers is imported
	process.env.TRANSFORMERS_CACHE_DIR = cacheDir;
	cacheConfigured = true;
}

async function loadPipeline() {
	if (!pipelineFn) {
		const transformers = await import("@xenova/transformers");
		// Set cache directory if configured via env
		const cacheDir = process.env.TRANSFORMERS_CACHE_DIR;
		if (cacheDir && transformers.env) {
			transformers.env.cacheDir = cacheDir;
		}
		pipelineFn = transformers.pipeline;
	}
	return pipelineFn;
}

export class TransformersEmbedder implements Embedder {
	readonly dimensions: number;
	readonly model: ModelSpec;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private pipe: any = null;
	private loading: Promise<void> | null = null;

	constructor(spec: ModelSpec) {
		this.model = spec;
		this.dimensions = spec.dimensions;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.pipe) return;
		if (this.loading) {
			await this.loading;
			return;
		}

		this.loading = (async () => {
			try {
				const pipeline = await loadPipeline();
				this.pipe = await pipeline("feature-extraction", this.model.id, {
					quantized: true,
				});
			} finally {
				this.loading = null;
			}
		})();

		await this.loading;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		await this.ensureLoaded();
		if (!this.pipe) throw new Error("Pipeline not loaded");

		if (texts.length === 1) {
			const output = await this.pipe(texts[0], { pooling: "mean", normalize: true });
			return [new Float32Array(output.data as ArrayLike<number>)];
		}

		try {
			const output = await this.pipe(texts, { pooling: "mean", normalize: true });
			if (Array.isArray(output)) {
				return output.map((o: { data: ArrayLike<number> }) => new Float32Array(o.data));
			}
			const data = output.data as ArrayLike<number>;
			const dim = this.dimensions;
			const results: Float32Array[] = [];
			for (let i = 0; i < texts.length; i++) {
				results.push(new Float32Array(Array.from(data).slice(i * dim, (i + 1) * dim)));
			}
			return results;
		} catch {
			const results: Float32Array[] = [];
			for (const text of texts) {
				const output = await this.pipe(text, { pooling: "mean", normalize: true });
				results.push(new Float32Array(output.data as ArrayLike<number>));
			}
			return results;
		}
	}

	async unload(): Promise<void> {
		this.pipe = null;
	}
}

export class OllamaEmbedder implements Embedder {
	readonly dimensions = 768;
	readonly model: ModelSpec;
	private baseUrl: string;

	constructor(baseUrl = "http://localhost:11434") {
		this.baseUrl = baseUrl;
		this.model = MODEL_REGISTRY.ollama!;
	}

	async embed(texts: string[]): Promise<Float32Array[]> {
		const results: Float32Array[] = [];

		for (const text of texts) {
			const res = await fetch(`${this.baseUrl}/api/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
				signal: AbortSignal.timeout(30000),
			});

			if (!res.ok) {
				throw new Error(`Ollama embedding failed: ${res.status}`);
			}

			const data = (await res.json()) as { embedding: number[] };
			results.push(new Float32Array(data.embedding));
		}

		return results;
	}

	async unload(): Promise<void> {}
}

export async function checkOllamaAvailable(baseUrl = "http://localhost:11434"): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return false;
		const data = (await res.json()) as { models?: Array<{ name: string }> };
		return data.models?.some((m) => m.name.startsWith("nomic-embed-text")) ?? false;
	} catch {
		return false;
	}
}

export async function createEmbedder(tier: ModelTier): Promise<Embedder | null> {
	if (tier === "none") return null;

	if (tier === "ollama") {
		const available = await checkOllamaAvailable();
		if (!available) {
			throw new Error("Ollama not available or nomic-embed-text not installed");
		}
		return new OllamaEmbedder();
	}

	const spec = MODEL_REGISTRY[tier];
	if (!spec) return null;

	return new TransformersEmbedder(spec);
}
