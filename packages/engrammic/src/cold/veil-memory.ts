/**
 * Veil-Memory ColdStore adapter.
 *
 * Uses FSRS decay, sqlite-vec semantic search, and version vectors.
 * The "fancy" cold storage option.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Import from veil-memory package
import {
	type ConflictPair,
	type CurrentBelief,
	MemoryStore,
	OllamaEmbedder,
	ServerEmbedder,
	type StoreConfig,
} from "@veil/memory";
import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

type EmbedderTier = "none" | "light" | "balanced" | "quality" | "max" | "ollama";

interface EmbedderConfig {
	tier: EmbedderTier;
	port?: number;
}

function readEmbedderConfig(): EmbedderConfig | null {
	const configPath = join(homedir(), ".veil", "embedder.json");
	if (!existsSync(configPath)) return null;
	try {
		return JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Derive a projectId from cwd for cross-project isolation.
 * Uses first 12 chars of sha256 for compact but collision-resistant ID.
 */
function deriveProjectId(cwd: string = process.cwd()): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

export interface SemanticConflictInfo {
	existingEventId: string;
	existingContent: string;
	existingConfidence: number;
	existingSourceTier: string;
	newContent: string;
	newConfidence: number;
	newSourceTier: string;
	similarity: number;
	autoResolved: boolean;
	resolution?: "new_wins" | "existing_wins" | "unresolved";
	reason?: string;
}

export interface VeilMemoryColdStoreConfig extends ColdStoreConfig {
	dbPath?: string;
	agentId?: string;
	// Project ID for cross-project isolation. Defaults to hash of cwd.
	projectId?: string;
	// Optional: override embedder config (defaults to reading ~/.veil/embedder.json)
	embedderTier?: EmbedderTier;
	ollamaBaseUrl?: string;
	// Callback when conflicts are detected during demote
	onConflict?: (newEventId: string, conflictsWith: string[], content: string) => void;
	// Callback for semantic conflicts with full provenance
	onSemanticConflict?: (conflict: SemanticConflictInfo) => void;
}

export type EmbedderStatus = "active" | "failed" | "disabled";

export class VeilMemoryColdStore implements ColdStore {
	private store: MemoryStore;
	private namespace: string;
	private _embedderStatus: EmbedderStatus = "disabled";
	private _embedderError?: string;
	private onConflict?: (newEventId: string, conflictsWith: string[], content: string) => void;
	private onSemanticConflict?: (conflict: SemanticConflictInfo) => void;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // sqlite-vec embeddings
		temporal: true, // bi-temporal storage
		provenance: true, // version vectors + source tiers
	};

	constructor(config: VeilMemoryColdStoreConfig) {
		// Derive projectId from cwd for cross-project isolation
		const projectId = config.projectId ?? deriveProjectId();
		// Use projectId as namespace for isolation (overrides config.namespace)
		this.namespace = config.namespace ?? projectId;
		this.onConflict = config.onConflict;
		this.onSemanticConflict = config.onSemanticConflict;

		// Global DB by default - enables cross-project sharing
		const globalDir = join(homedir(), ".veil");
		const dbPath = config.dbPath ?? join(globalDir, "cold.db");

		// Ensure ~/.veil exists for global DB
		if (!config.dbPath && !existsSync(globalDir)) {
			mkdirSync(globalDir, { recursive: true });
		}

		const storeConfig: StoreConfig = {
			dbPath,
			namespace: this.namespace,
			agentId: config.agentId ?? "veil-harness",
		};

		this.store = new MemoryStore(storeConfig);

		// Wire up embedder for semantic search based on tier
		const embedderConfig = readEmbedderConfig();
		const tier = config.embedderTier ?? embedderConfig?.tier ?? "none";

		if (tier !== "none") {
			try {
				if (tier === "ollama") {
					const embedder = new OllamaEmbedder(
						config.ollamaBaseUrl ? { baseUrl: config.ollamaBaseUrl } : undefined,
					);
					this.store.setEmbedder(embedder);
				} else {
					// light/balanced/quality/max use local embedder server
					const embedder = new ServerEmbedder(embedderConfig?.port);
					this.store.setEmbedder(embedder);
				}
				this._embedderStatus = "active";
			} catch (err) {
				this._embedderStatus = "failed";
				this._embedderError = err instanceof Error ? err.message : String(err);
				console.warn(`[veil-memory] Embedder init failed: ${this._embedderError}. Falling back to FTS5.`);
			}
		}
	}

	async demote(item: ContextItem): Promise<string> {
		const memoryType = this.mapType(item.type);
		const subject = this.extractSubject(item);

		// Use the appropriate store method based on type
		if (memoryType === "episodic") {
			// remember() returns string directly
			return this.store.remember(item.content, {
				tags: item.tags,
				sourceTier: item.pinned ? "authoritative" : "observed",
			});
		} else if (memoryType === "procedural") {
			// skill() takes (content, subject, options)
			return this.store.skill(item.content, subject, {
				confidence: this.mapCognitiveWeight(item.cognitiveWeight),
				tags: item.tags,
				sourceTier: item.pinned ? "authoritative" : "validated",
			});
		} else {
			// factual - learn() returns {eventId, conflictsWith?, semanticConflicts?}
			const sourceTier = item.pinned ? "authoritative" : "observed";
			const confidence = this.mapCognitiveWeight(item.cognitiveWeight);
			const result = await this.store.learn(item.content, subject, {
				confidence,
				tags: item.tags,
				sourceTier,
				sourceToolName: item.sourceToolName,
				sourcePath: item.sourcePath,
				sessionId: item.sourceSessionId,
			});

			// Notify if subject-based conflicts detected
			if (result.conflictsWith && result.conflictsWith.length > 0 && this.onConflict) {
				this.onConflict(result.eventId, result.conflictsWith, item.content.slice(0, 50));
			}

			// Notify for semantic conflicts with full provenance
			if (result.semanticConflicts && this.onSemanticConflict) {
				for (const sc of result.semanticConflicts) {
					this.onSemanticConflict({
						existingEventId: sc.existingEventId,
						existingContent: sc.existingContent,
						existingConfidence: sc.existingConfidence,
						existingSourceTier: sc.existingSourceTier,
						newContent: item.content,
						newConfidence: confidence,
						newSourceTier: sourceTier,
						similarity: sc.similarity,
						autoResolved: sc.autoResolved,
						resolution: sc.resolution,
						reason: sc.reason,
					});
				}
			}

			return result.eventId;
		}
	}

	async fetch(pointer: string): Promise<ContextItem | null> {
		// Direct lookup by event ID
		const belief = this.store.getById(pointer);
		if (belief) {
			return this.beliefToItem(belief, pointer);
		}
		return null;
	}

	async delete(pointer: string): Promise<void> {
		this.store.forget(pointer, "demoted item deleted");
	}

	async exists(pointer: string): Promise<boolean> {
		return this.store.getById(pointer) !== null;
	}

	async count(): Promise<number> {
		const stats = this.store.stats();
		return stats.total;
	}

	async query(text: string, tags: string[], limit: number): Promise<ContextItem[]> {
		const results = await this.store.recall(text, {
			namespace: this.namespace,
			limit,
			includeCold: true,
			tags: tags.length > 0 ? tags : undefined,
		});

		return results
			.filter((r): r is CurrentBelief => "eventId" in r)
			.map((belief) => this.beliefToItem(belief, belief.eventId));
	}

	async close(): Promise<void> {
		this.store.close();
	}

	// --- Analytics / debugging ---

	getStats(): {
		total: number;
		byType: { episodic: number; factual: number; procedural: number };
		conflicts: number;
		avgRetrievability: number;
		lowRCount: number;
		embedderStatus: EmbedderStatus;
		embedderError?: string;
	} {
		return {
			...this.store.stats(),
			embedderStatus: this._embedderStatus,
			embedderError: this._embedderError,
		};
	}

	get embedderStatus(): EmbedderStatus {
		return this._embedderStatus;
	}

	get embedderError(): string | undefined {
		return this._embedderError;
	}

	getConflicts(): ConflictPair[] {
		return this.store.conflicts();
	}

	/**
	 * Resolve a conflict by picking a winner.
	 * The loser is retracted, winner remains as the current belief.
	 */
	resolveConflict(conflictEventId: string, winnerEventId: string, reason: string): void {
		this.store.resolve(conflictEventId, winnerEventId, reason);
	}

	/** Get raw access to the underlying store for advanced operations */
	getStore(): MemoryStore {
		return this.store;
	}

	// --- Private helpers ---

	private mapType(type: ContextItem["type"]): "episodic" | "factual" | "procedural" {
		switch (type) {
			case "episodic":
				return "episodic";
			case "procedural":
				return "procedural";
			case "fact":
				return "factual";
			default:
				return "episodic";
		}
	}

	private reverseMapType(type: string): ContextItem["type"] {
		switch (type) {
			case "episodic":
				return "episodic";
			case "procedural":
				return "procedural";
			case "factual":
				return "fact";
			default:
				return "episodic";
		}
	}

	private mapCognitiveWeight(weight: number): number {
		// cognitiveWeight is -1 to +1, confidence is 0 to 1
		return (weight + 1) / 2;
	}

	private extractSubject(item: ContextItem): string {
		// Try to extract a subject from tags or content
		if (item.tags.length > 0) {
			return item.tags[0];
		}
		// Use first 50 chars as subject
		return item.content.slice(0, 50).replace(/\n/g, " ").trim();
	}

	private hash(content: string): string {
		return createHash("sha256").update(content).digest("hex").slice(0, 16);
	}

	private beliefToItem(belief: CurrentBelief, pointer: string): ContextItem {
		return {
			id: belief.eventId,
			content: belief.content,
			contentHash: belief.subjectHash ?? this.hash(belief.content),
			createdAt: belief.recordedAt,
			lastAccess: belief.lastRecall ?? belief.recordedAt,
			accessCount: belief.recallCount,
			usedCount: 0,
			ignoredCount: 0,
			decayScore: belief.retrievability,
			cognitiveWeight: belief.confidence * 2 - 1, // 0-1 → -1 to +1
			stability: belief.stability,
			difficulty: belief.difficulty,
			type: this.reverseMapType(belief.memoryType),
			tags: belief.tags,
			pinned: false,
			kgPointer: pointer,
			validFrom: belief.validFrom,
			source: "auto",
		};
	}
}
