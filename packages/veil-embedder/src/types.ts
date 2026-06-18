/**
 * Embedding model configuration and types.
 */

export type ModelTier = "none" | "light" | "balanced" | "quality" | "max" | "ollama";

export interface ModelSpec {
	tier: ModelTier;
	id: string;
	name: string;
	size: string;
	ram: string;
	dimensions: number;
	languages: string;
	description: string;
}

export const MODEL_REGISTRY: Record<ModelTier, ModelSpec | null> = {
	none: null,
	light: {
		tier: "light",
		id: "Xenova/all-MiniLM-L6-v2",
		name: "all-MiniLM-L6-v2",
		size: "23MB",
		ram: "~100MB",
		dimensions: 384,
		languages: "English",
		description: "Fast, lightweight, English-focused",
	},
	balanced: {
		tier: "balanced",
		id: "Xenova/multilingual-e5-small",
		name: "multilingual-e5-small",
		size: "118MB",
		ram: "~300MB",
		dimensions: 384,
		languages: "100+",
		description: "Good quality, multilingual support",
	},
	quality: {
		tier: "quality",
		id: "Xenova/multilingual-e5-base",
		name: "multilingual-e5-base",
		size: "278MB",
		ram: "~600MB",
		dimensions: 768,
		languages: "100+",
		description: "Better quality, multilingual support",
	},
	max: {
		tier: "max",
		id: "Xenova/multilingual-e5-large",
		name: "multilingual-e5-large",
		size: "560MB",
		ram: "~1.2GB",
		dimensions: 1024,
		languages: "100+",
		description: "Best quality, multilingual support",
	},
	ollama: {
		tier: "ollama",
		id: "nomic-embed-text",
		name: "nomic-embed-text (Ollama)",
		size: "275MB",
		ram: "~500MB",
		dimensions: 768,
		languages: "English+",
		description: "Requires Ollama running locally",
	},
};

export interface EmbedRequest {
	texts: string[];
}

export interface EmbedResponse {
	embeddings: number[][];
	model: string;
	dimensions: number;
}

export interface ServerStatus {
	ready: boolean;
	model: ModelSpec | null;
	uptime: number;
	requestCount: number;
}

export interface EmbedderConfig {
	tier: ModelTier;
	cachePath: string;
	idleTimeoutMs: number;
	port: number;
}

export const DEFAULT_CONFIG: EmbedderConfig = {
	tier: "balanced",
	cachePath: "",
	idleTimeoutMs: 30 * 60 * 1000,
	port: 19532,
};
