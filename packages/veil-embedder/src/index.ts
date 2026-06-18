/**
 * Veil Embedder - Persistent embedding model server
 *
 * Provides semantic search embeddings for veil-memory with:
 * - Multiple model tiers (light → max)
 * - Shared server across Veil sessions
 * - Auto-start and idle timeout
 * - Ollama fallback support
 */

export {
	CONFIG_DIR,
	CONFIG_FILE,
	EmbedderClient,
	type EmbedderClientConfig,
	getServerPid,
	isServerProcessRunning,
	LOG_DIR,
	LOG_FILE,
	loadConfig,
	PID_FILE,
	saveConfig,
} from "./client.ts";
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
