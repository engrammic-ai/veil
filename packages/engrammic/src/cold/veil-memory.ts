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
import { AliasTable } from "./alias-table.ts";
import { type EntityRef, extractFingerprint, fingerprintSimilarity } from "./entity.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig, ListOptions, ListResult } from "./interface.ts";

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

/** Convert glob pattern to SQL LIKE syntax (case-insensitive mode). Note: [abc] sets are unsupported. */
function globToLike(glob: string): string {
	return glob.replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*/g, "%").replace(/\?/g, "_");
}

/** Escape special LIKE characters in a literal prefix string. */
function escapeLike(literal: string): string {
	return literal.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export class VeilMemoryColdStore implements ColdStore {
	private store: MemoryStore;
	private namespace: string;
	private _embedderStatus: EmbedderStatus = "disabled";
	private _embedderError?: string;
	private onConflict?: (newEventId: string, conflictsWith: string[], content: string) => void;
	private onSemanticConflict?: (conflict: SemanticConflictInfo) => void;
	private aliasTable: AliasTable = new AliasTable();
	private entities: Map<string, EntityRef> = new Map();

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // sqlite-vec embeddings
		temporal: true, // bi-temporal storage
		provenance: true, // version vectors + source tiers
		glob: true,
		listing: true,
		entityResolution: true,
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
		// Star query: list recent items, no semantic search
		if (text === "*") {
			const result = await this.list({ tags, limit, sort: "recent" });
			return result.items;
		}

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

	async list(options: ListOptions = {}): Promise<ListResult> {
		const db = (this.store as unknown as { db: import("better-sqlite3").Database }).db;
		const matchOp = options.ignoreCase ? "LIKE" : "GLOB";

		let sql = `SELECT cb.*, me.tags FROM current_beliefs cb
      JOIN memory_events me ON cb.event_id = me.event_id
      WHERE cb.namespace = ?`;
		const params: unknown[] = [this.namespace];

		if (options.tags?.length) {
			for (const pattern of options.tags) {
				if (options.ignoreCase && /\[/.test(pattern)) {
					throw new Error(
						`Character sets [abc] not supported with ignoreCase=true. Use case-sensitive mode or multiple patterns. (pattern: "${pattern}")`,
					);
				}
				const sqlPattern = options.ignoreCase ? globToLike(pattern) : pattern;
				sql += ` AND EXISTS (
          SELECT 1 FROM json_each(me.tags)
          WHERE json_each.value ${matchOp} ?
        )`;
				params.push(sqlPattern);
			}
		}

		// Count total before pagination
		const countSql = `SELECT COUNT(*) as count FROM (${sql})`;
		const { count: total } = db.prepare(countSql).get(...params) as { count: number };

		sql +=
			options.sort === "oldest"
				? ` ORDER BY me.recorded_at ASC`
				: ` ORDER BY cb.last_recall DESC, me.recorded_at DESC`;

		const offset = options.cursor ? parseInt(options.cursor, 10) : 0;
		const limit = options.limit ?? 100;
		sql += ` LIMIT ? OFFSET ?`;
		params.push(limit, offset);

		const rows = db.prepare(sql).all(...params) as Array<{
			event_id: string;
			namespace: string;
			content: string;
			memory_type: string;
			subject: string | null;
			subject_hash: string | null;
			confidence: number;
			valid_from: number;
			recorded_at: number;
			difficulty: number;
			stability: number;
			retrievability: number;
			last_recall: number | null;
			recall_count: number;
			has_conflicts: number;
			conflict_event_ids: string | null;
			tags: string;
		}>;

		const items = rows.map((row) =>
			this.beliefToItem(
				{
					eventId: row.event_id,
					namespace: row.namespace,
					content: row.content,
					memoryType: row.memory_type as import("@veil/memory").MemoryType,
					subject: row.subject ?? undefined,
					subjectHash: row.subject_hash ?? undefined,
					confidence: row.confidence,
					validFrom: row.valid_from,
					recordedAt: row.recorded_at,
					difficulty: row.difficulty,
					stability: row.stability,
					retrievability: row.retrievability,
					lastRecall: row.last_recall ?? undefined,
					recallCount: row.recall_count,
					hasConflicts: row.has_conflicts === 1,
					conflictEventIds: row.conflict_event_ids ? JSON.parse(row.conflict_event_ids) : undefined,
					tags: JSON.parse(row.tags),
				},
				row.event_id,
			),
		);

		const nextOffset = offset + limit;
		return {
			items,
			nextCursor: nextOffset < total ? String(nextOffset) : undefined,
			total,
		};
	}

	async fetchByPrefix(prefix: string, limit = 100): Promise<ContextItem[]> {
		const db = (this.store as unknown as { db: import("better-sqlite3").Database }).db;

		const rows = db
			.prepare(
				`SELECT cb.*, me.tags FROM current_beliefs cb
        JOIN memory_events me ON cb.event_id = me.event_id
        WHERE cb.namespace = ? AND cb.event_id LIKE ? ESCAPE '\\'
        LIMIT ?`,
			)
			.all(this.namespace, `${escapeLike(prefix)}%`, limit) as Array<{
			event_id: string;
			namespace: string;
			content: string;
			memory_type: string;
			subject: string | null;
			subject_hash: string | null;
			confidence: number;
			valid_from: number;
			recorded_at: number;
			difficulty: number;
			stability: number;
			retrievability: number;
			last_recall: number | null;
			recall_count: number;
			has_conflicts: number;
			conflict_event_ids: string | null;
			tags: string;
		}>;

		return rows.map((row) =>
			this.beliefToItem(
				{
					eventId: row.event_id,
					namespace: row.namespace,
					content: row.content,
					memoryType: row.memory_type as import("@veil/memory").MemoryType,
					subject: row.subject ?? undefined,
					subjectHash: row.subject_hash ?? undefined,
					confidence: row.confidence,
					validFrom: row.valid_from,
					recordedAt: row.recorded_at,
					difficulty: row.difficulty,
					stability: row.stability,
					retrievability: row.retrievability,
					lastRecall: row.last_recall ?? undefined,
					recallCount: row.recall_count,
					hasConflicts: row.has_conflicts === 1,
					conflictEventIds: row.conflict_event_ids ? JSON.parse(row.conflict_event_ids) : undefined,
					tags: JSON.parse(row.tags),
				},
				row.event_id,
			),
		);
	}

	async resolveEntities(items: ContextItem[]): Promise<{
		resolved: ContextItem[];
		needsReview: Array<{ item: ContextItem; candidates: EntityRef[] }>;
	}> {
		const resolved: ContextItem[] = [];
		const needsReview: Array<{ item: ContextItem; candidates: EntityRef[] }> = [];

		// Group items by normalized entity name extracted from content
		const groups = new Map<string, ContextItem[]>();
		for (const item of items) {
			const name = this.extractEntityName(item.content);
			const existing = groups.get(name) ?? [];
			existing.push(item);
			groups.set(name, existing);
		}

		for (const [name, group] of groups) {
			// Check alias table first
			const aliasedId = this.aliasTable.resolve(name);
			if (aliasedId) {
				const entity = this.entities.get(aliasedId);
				if (entity) {
					for (const item of group) {
						resolved.push({ ...item, entityRef: aliasedId });
					}
					continue;
				}
			}

			// Compute fingerprints for each item in the group
			const fingerprints = group.map((item) => extractFingerprint(item.content));

			// Cluster by pairwise similarity
			// Each cluster is a set of item indices
			const clusterOf = new Array<number>(group.length).fill(-1);
			let clusterCount = 0;

			for (let i = 0; i < group.length; i++) {
				if (clusterOf[i] !== -1) continue;
				clusterOf[i] = clusterCount++;

				for (let j = i + 1; j < group.length; j++) {
					if (clusterOf[j] !== -1) continue;
					const sim = fingerprintSimilarity(fingerprints[i], fingerprints[j]);
					if (sim > 0.8) {
						clusterOf[j] = clusterOf[i];
					}
				}
			}

			// Build clusters
			const clusters = new Map<number, number[]>();
			for (let i = 0; i < group.length; i++) {
				const c = clusterOf[i];
				const existing = clusters.get(c) ?? [];
				existing.push(i);
				clusters.set(c, existing);
			}

			// For each cluster, find or create an entity and check for ambiguous items
			for (const [, indices] of clusters) {
				// Representative fingerprint: union of all fingerprints in cluster
				const repFingerprint = [...new Set(indices.flatMap((i) => fingerprints[i]))].slice(0, 10);

				// Find the best matching existing entity by fingerprint similarity
				let bestEntity: EntityRef | null = null;
				let bestSim = 0;
				for (const entity of this.entities.values()) {
					if (entity.canonicalName.toLowerCase() !== name) continue;
					const sim = fingerprintSimilarity(entity.fingerprint, repFingerprint);
					if (sim > bestSim) {
						bestSim = sim;
						bestEntity = entity;
					}
				}

				if (bestSim > 0.8 && bestEntity) {
					// Clear match: assign to existing entity
					for (const i of indices) {
						resolved.push({ ...group[i], entityRef: bestEntity.id });
					}
				} else if (bestSim >= 0.5 && bestEntity) {
					// Ambiguous: surface for review
					const candidates = this.candidatesForName(name, repFingerprint);
					for (const i of indices) {
						needsReview.push({ item: group[i], candidates });
					}
				} else {
					// No matching entity — check cross-cluster ambiguity before auto-creating
					// Find all existing entities with this canonical name
					const sameNameEntities = [...this.entities.values()].filter(
						(e) => e.canonicalName.toLowerCase() === name,
					);

					if (sameNameEntities.length > 0) {
						// There are other entities with this name — needs human disambiguation
						for (const i of indices) {
							needsReview.push({ item: group[i], candidates: sameNameEntities });
						}
					} else {
						// New entity: auto-create and resolve
						const newEntity = await this.createEntity({
							canonicalName: name,
							aliases: [],
							fingerprint: repFingerprint,
							sources: [],
						});
						for (const i of indices) {
							resolved.push({ ...group[i], entityRef: newEntity.id });
						}
					}
				}
			}
		}

		return { resolved, needsReview };
	}

	async addEntityAlias(variant: string, canonicalId: string): Promise<void> {
		this.aliasTable.addAlias(variant, canonicalId);
	}

	async getEntity(id: string): Promise<EntityRef | null> {
		return this.entities.get(id) ?? null;
	}

	async createEntity(entity: Omit<EntityRef, "id">): Promise<EntityRef> {
		const id = `entity_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const newEntity: EntityRef = { id, ...entity };
		this.entities.set(id, newEntity);
		return newEntity;
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

	/** Extract a normalized entity name: first run of capitalized words, or first meaningful token. */
	private extractEntityName(content: string): string {
		const capitalized = content.match(/\b([A-Z][a-zA-Z0-9-]*(?:\s+[A-Z][a-zA-Z0-9-]*)*)\b/);
		if (capitalized) return capitalized[1].toLowerCase().trim();
		// Fallback: first non-stopword token
		const tokens = content
			.toLowerCase()
			.split(/\W+/)
			.filter((t) => t.length > 2);
		return tokens[0] ?? "unknown";
	}

	/** Return all known entities whose canonical name matches and that have non-trivial fingerprint overlap. */
	private candidatesForName(name: string, fingerprint: string[]): EntityRef[] {
		return [...this.entities.values()].filter(
			(e) => e.canonicalName.toLowerCase() === name || fingerprintSimilarity(e.fingerprint, fingerprint) >= 0.5,
		);
	}

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
