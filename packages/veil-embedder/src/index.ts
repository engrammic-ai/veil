/**
 * Veil Embedder - Persistent embedding model server
 *
 * Provides semantic search embeddings for veil-memory with:
 * - Multiple model tiers (light → max)
 * - Shared server across Veil sessions
 * - Auto-start and idle timeout
 * - Ollama fallback support
 */

export { EmbedderClient, type EmbedderClientConfig, getServerPid, isServerProcessRunning } from "./client.ts";
export {
	checkOllamaAvailable,
	createEmbedder,
	type Embedder,
	OllamaEmbedder,
	TransformersEmbedder,
} from "./embedder.ts";
export {
	DEFAULT_CONFIG,
	type EmbedderConfig,
	type EmbedRequest,
	type EmbedResponse,
	MODEL_REGISTRY,
	type ModelSpec,
	type ModelTier,
	type ServerStatus,
} from "./types.ts";
