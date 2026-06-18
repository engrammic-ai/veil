/**
 * Embedder interface and factory.
 */

export interface Embedder {
	embed(text: string): Promise<Float32Array>;
	embedBatch?(texts: string[]): Promise<Float32Array[]>;
	readonly dimensions: number;
}

export { OllamaEmbedder } from "./ollama.ts";
export { ServerEmbedder } from "./server.ts";
