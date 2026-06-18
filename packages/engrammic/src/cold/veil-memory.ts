/**
 * Veil-Memory ColdStore adapter.
 *
 * Uses FSRS decay, sqlite-vec semantic search, and version vectors.
 * The "fancy" cold storage option.
 */

import { createHash } from "node:crypto";
import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

// Import from veil-memory package
import {
	MemoryStore,
	type StoreConfig,
	type CurrentBelief,
	type MemoryStub,
	type ConflictPair,
} from "@veil/memory";

export interface VeilMemoryColdStoreConfig extends ColdStoreConfig {
	dbPath?: string;
	agentId?: string;
	// Optional: enable Ollama embeddings for semantic search
	enableEmbeddings?: boolean;
	ollamaBaseUrl?: string;
}

export class VeilMemoryColdStore implements ColdStore {
	private store: MemoryStore;
	private namespace: string;

	readonly capabilities: ColdStoreCapabilities = {
		semantic: true, // sqlite-vec embeddings
		temporal: true, // bi-temporal storage
		provenance: true, // version vectors + source tiers
	};

	constructor(config: VeilMemoryColdStoreConfig) {
		this.namespace = config.namespace ?? "default";

		const storeConfig: StoreConfig = {
			dbPath: config.dbPath ?? ".veil/memory.db",
			namespace: this.namespace,
			agentId: config.agentId ?? "veil-harness",
		};

		// TODO: wire up embedder if enableEmbeddings is true
		this.store = new MemoryStore(storeConfig);
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
			// factual - learn() returns {eventId, conflictsWith?}
			const result = await this.store.learn(item.content, subject, {
				confidence: this.mapCognitiveWeight(item.cognitiveWeight),
				tags: item.tags,
				sourceTier: item.pinned ? "authoritative" : "observed",
			});
			return result.eventId;
		}
	}

	async fetch(pointer: string): Promise<ContextItem | null> {
		const results = await this.store.recall("", {
			namespace: this.namespace,
			limit: 100,
			includeCold: true,
		});

		// Find by event ID
		const found = results.find((r) => {
			if ("eventId" in r) return r.eventId === pointer;
			if ("id" in r) return r.id === pointer;
			return false;
		});

		if (!found) return null;

		// Convert back to ContextItem
		if ("eventId" in found) {
			return this.beliefToItem(found as CurrentBelief, pointer);
		} else {
			// It's a stub, need to hydrate it
			const stub = found as MemoryStub;
			return {
				id: stub.id,
				content: stub.summary,
				contentHash: this.hash(stub.summary),
				createdAt: Date.now(),
				lastAccess: Date.now(),
				accessCount: 1,
				decayScore: stub.retrievability,
				cognitiveWeight: 0,
				type: this.reverseMapType(stub.memoryType),
				tags: [],
				pinned: false,
				kgPointer: pointer,
				source: "auto",
			};
		}
	}

	async delete(pointer: string): Promise<void> {
		this.store.forget(pointer, "demoted item deleted");
	}

	async exists(pointer: string): Promise<boolean> {
		const results = await this.store.recall("", {
			namespace: this.namespace,
			limit: 100,
			includeCold: true,
		});

		return results.some((r) => {
			if ("eventId" in r) return r.eventId === pointer;
			if ("id" in r) return r.id === pointer;
			return false;
		});
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
			// TODO: filter by tags when veil-memory supports it
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
	} {
		return this.store.stats();
	}

	getConflicts(): ConflictPair[] {
		return this.store.conflicts();
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
			decayScore: belief.retrievability,
			cognitiveWeight: belief.confidence * 2 - 1, // 0-1 → -1 to +1
			type: this.reverseMapType(belief.memoryType),
			tags: [], // TODO: retrieve from event
			pinned: false,
			kgPointer: pointer,
			validFrom: belief.validFrom,
			source: "auto",
		};
	}
}
