/**
 * MemoryStore: main interface to the memory system.
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import * as sqliteVec from "sqlite-vec";
import { ulid } from "ulid";
import { type FSRSConfig, FSRSEngine } from "./fsrs.ts";
import { initSchema } from "./schema.ts";
import type {
	ConflictPair,
	ConsolidationResult,
	CurrentBelief,
	LearnOptions,
	MemoryEvent,
	MemoryHealth,
	MemoryStub,
	MemoryType,
	RecallOptions,
	RememberOptions,
	SourceTier,
	VersionVector,
} from "./types.ts";
import { dominates, increment } from "./version-vector.ts";

export interface StoreConfig {
	dbPath: string;
	namespace: string;
	agentId: string;
	fsrs?: Partial<FSRSConfig>;
	vectorDimensions?: number;
}

export interface Embedder {
	embed(text: string): Promise<Float32Array>;
	embedBatch?(texts: string[]): Promise<Float32Array[]>;
	readonly dimensions: number;
}

export class MemoryStore {
	private db: Database.Database;
	private fsrs: FSRSEngine;
	private namespace: string;
	private agentId: string;
	private embedder?: Embedder;

	constructor(config: StoreConfig) {
		this.db = new Database(config.dbPath);
		this.db.pragma("journal_mode = WAL");
		sqliteVec.load(this.db);
		initSchema(this.db);

		this.fsrs = new FSRSEngine(config.fsrs);
		this.namespace = config.namespace;
		this.agentId = config.agentId;
	}

	setEmbedder(embedder: Embedder): void {
		this.embedder = embedder;
	}

	private hash(text: string): string {
		return createHash("sha256").update(text).digest("hex").slice(0, 16);
	}

	private formatAge(timestamp: number): string {
		const ms = Date.now() - timestamp;
		const mins = Math.floor(ms / 60000);
		if (mins < 60) return `${mins}min ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}hr ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	async learn(
		content: string,
		subject: string,
		options: LearnOptions = {},
	): Promise<{ eventId: string; conflictsWith?: string[] }> {
		const eventId = ulid();
		const now = Date.now();
		const ns = options.namespace ?? this.namespace;
		const subjectHash = this.hash(subject);

		const currentEvent = this.db
			.prepare(`
      SELECT event_id, version_vector FROM memory_events
      WHERE namespace = ? AND subject_hash = ? AND memory_type IN ('factual', 'procedural')
      ORDER BY recorded_at DESC LIMIT 1
    `)
			.get(ns, subjectHash) as { event_id: string; version_vector: string } | undefined;

		const currentVV: VersionVector = currentEvent ? JSON.parse(currentEvent.version_vector) : {};
		const newVV = increment(currentVV, this.agentId);

		const event: Partial<MemoryEvent> = {
			eventId,
			namespace: ns,
			eventType: "assert",
			agentId: this.agentId,
			content,
			contentHash: this.hash(content),
			memoryType: "factual",
			subject,
			subjectHash,
			versionVector: newVV,
			confidence: options.confidence ?? 0.8,
			evidenceCount: options.evidenceCount ?? 1,
			validFrom: now,
			recordedAt: now,
			difficulty: this.fsrs.getInitialDifficulty(),
			stability: this.fsrs.getInitialStability("factual"),
			embeddingModel: "nomic-embed-text-v1.5",
			sourceTier: options.sourceTier ?? "observed",
			tags: options.tags ?? [],
		};

		this.db
			.prepare(`
      INSERT INTO memory_events (
        event_id, namespace, event_type, agent_id, content, content_hash,
        memory_type, subject, subject_hash, version_vector, confidence,
        evidence_count, valid_from, recorded_at, difficulty, stability,
        embedding_model, source_tier, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				event.eventId,
				event.namespace,
				event.eventType,
				event.agentId,
				event.content,
				event.contentHash,
				event.memoryType,
				event.subject,
				event.subjectHash,
				JSON.stringify(event.versionVector),
				event.confidence,
				event.evidenceCount,
				event.validFrom,
				event.recordedAt,
				event.difficulty,
				event.stability,
				event.embeddingModel,
				event.sourceTier,
				JSON.stringify(event.tags),
			);

		if (this.embedder) {
			const embedding = await this.embedder.embed(content);
			const result = this.db.prepare("INSERT INTO memory_vectors (embedding) VALUES (?)").run(embedding);
			this.db
				.prepare("INSERT INTO memory_vector_map (rowid, event_id) VALUES (?, ?)")
				.run(result.lastInsertRowid, eventId);
		}

		let conflictsWith: string[] | undefined;
		if (currentEvent && !dominates(newVV, JSON.parse(currentEvent.version_vector))) {
			conflictsWith = [currentEvent.event_id];
		}

		this.updateProjection(event as MemoryEvent, conflictsWith);

		return { eventId, conflictsWith };
	}

	async remember(content: string, options: RememberOptions = {}): Promise<string> {
		const eventId = ulid();
		const now = Date.now();
		const ns = options.namespace ?? this.namespace;

		const event: Partial<MemoryEvent> = {
			eventId,
			namespace: ns,
			eventType: "assert",
			agentId: this.agentId,
			content,
			contentHash: this.hash(content),
			memoryType: "episodic",
			versionVector: { [this.agentId]: 1 },
			confidence: 1.0,
			evidenceCount: 1,
			validFrom: now,
			recordedAt: now,
			difficulty: this.fsrs.getInitialDifficulty(),
			stability: this.fsrs.getInitialStability("episodic"),
			embeddingModel: "nomic-embed-text-v1.5",
			sourceTier: options.sourceTier ?? "observed",
			tags: options.tags ?? [],
		};

		this.db
			.prepare(`
      INSERT INTO memory_events (
        event_id, namespace, event_type, agent_id, content, content_hash,
        memory_type, version_vector, confidence, evidence_count,
        valid_from, recorded_at, difficulty, stability, embedding_model,
        source_tier, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				event.eventId,
				event.namespace,
				event.eventType,
				event.agentId,
				event.content,
				event.contentHash,
				event.memoryType,
				JSON.stringify(event.versionVector),
				event.confidence,
				event.evidenceCount,
				event.validFrom,
				event.recordedAt,
				event.difficulty,
				event.stability,
				event.embeddingModel,
				event.sourceTier,
				JSON.stringify(event.tags),
			);

		if (this.embedder) {
			const embedding = await this.embedder.embed(content);
			const result = this.db.prepare("INSERT INTO memory_vectors (embedding) VALUES (?)").run(embedding);
			this.db
				.prepare("INSERT INTO memory_vector_map (rowid, event_id) VALUES (?, ?)")
				.run(result.lastInsertRowid, eventId);
		}

		this.updateProjection(event as MemoryEvent);

		return eventId;
	}

	async skill(content: string, subject: string, options: LearnOptions = {}): Promise<string> {
		const eventId = ulid();
		const now = Date.now();
		const ns = options.namespace ?? this.namespace;
		const subjectHash = this.hash(subject);

		const currentEvent = this.db
			.prepare(`
      SELECT version_vector FROM memory_events
      WHERE namespace = ? AND subject_hash = ? AND memory_type = 'procedural'
      ORDER BY recorded_at DESC LIMIT 1
    `)
			.get(ns, subjectHash) as { version_vector: string } | undefined;

		const currentVV: VersionVector = currentEvent ? JSON.parse(currentEvent.version_vector) : {};
		const newVV = increment(currentVV, this.agentId);

		const event: Partial<MemoryEvent> = {
			eventId,
			namespace: ns,
			eventType: "assert",
			agentId: this.agentId,
			content,
			contentHash: this.hash(content),
			memoryType: "procedural",
			subject,
			subjectHash,
			versionVector: newVV,
			confidence: options.confidence ?? 0.9,
			evidenceCount: options.evidenceCount ?? 1,
			validFrom: now,
			recordedAt: now,
			difficulty: this.fsrs.getInitialDifficulty(),
			stability: this.fsrs.getInitialStability("procedural"),
			embeddingModel: "nomic-embed-text-v1.5",
			sourceTier: options.sourceTier ?? "observed",
			tags: options.tags ?? [],
		};

		this.db
			.prepare(`
      INSERT INTO memory_events (
        event_id, namespace, event_type, agent_id, content, content_hash,
        memory_type, subject, subject_hash, version_vector, confidence,
        evidence_count, valid_from, recorded_at, difficulty, stability,
        embedding_model, source_tier, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
			.run(
				event.eventId,
				event.namespace,
				event.eventType,
				event.agentId,
				event.content,
				event.contentHash,
				event.memoryType,
				event.subject,
				event.subjectHash,
				JSON.stringify(event.versionVector),
				event.confidence,
				event.evidenceCount,
				event.validFrom,
				event.recordedAt,
				event.difficulty,
				event.stability,
				event.embeddingModel,
				event.sourceTier,
				JSON.stringify(event.tags),
			);

		if (this.embedder) {
			const embedding = await this.embedder.embed(content);
			const result = this.db.prepare("INSERT INTO memory_vectors (embedding) VALUES (?)").run(embedding);
			this.db
				.prepare("INSERT INTO memory_vector_map (rowid, event_id) VALUES (?, ?)")
				.run(result.lastInsertRowid, eventId);
		}

		this.updateProjection(event as MemoryEvent);

		return eventId;
	}

	async recall(query: string, options: RecallOptions = {}): Promise<Array<CurrentBelief | MemoryStub>> {
		const ns = options.namespace ?? this.namespace;
		const limit = options.limit ?? 10;
		const minR = options.minRetrievability ?? 0.1;
		const includeCold = options.includeCold ?? false;
		const useVectors = options.useVectors ?? true;

		this.refreshRetrievabilities(ns);

		let eventIds: string[] = [];

		if (query?.trim()) {
			if (useVectors && this.embedder) {
				eventIds = await this.vectorSearch(query, ns, limit * 2);
			}

			if (eventIds.length === 0) {
				eventIds = this.ftsSearch(query, ns, limit * 2);
			}
		}

		let sql: string;
		let params: (string | number)[];

		if (eventIds.length > 0) {
			const placeholders = eventIds.map(() => "?").join(",");
			sql = `
        SELECT * FROM current_beliefs
        WHERE namespace = ? AND retrievability >= ? AND event_id IN (${placeholders})
      `;
			params = [ns, minR, ...eventIds];
		} else {
			sql = `
        SELECT * FROM current_beliefs
        WHERE namespace = ? AND retrievability >= ?
      `;
			params = [ns, minR];
		}

		if (options.types && options.types.length > 0) {
			sql += ` AND memory_type IN (${options.types.map(() => "?").join(",")})`;
			params.push(...options.types);
		}

		sql += " ORDER BY retrievability DESC LIMIT ?";
		params.push(limit);

		const beliefs = this.db.prepare(sql).all(...params) as Array<{
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
		}>;

		const coldThreshold = this.fsrs.config.tierWarm;

		return beliefs.map((b) => {
			if (b.retrievability <= coldThreshold && !includeCold) {
				return {
					id: b.event_id,
					summary: b.content.slice(0, 50),
					subject: b.subject ?? undefined,
					memoryType: b.memory_type as MemoryType,
					retrievability: b.retrievability,
					age: this.formatAge(b.recorded_at),
				} as MemoryStub;
			}

			this.recordRecall(b.event_id);

			return {
				eventId: b.event_id,
				namespace: b.namespace,
				content: b.content,
				memoryType: b.memory_type as MemoryType,
				subject: b.subject ?? undefined,
				subjectHash: b.subject_hash ?? undefined,
				confidence: b.confidence,
				validFrom: b.valid_from,
				recordedAt: b.recorded_at,
				difficulty: b.difficulty,
				stability: b.stability,
				retrievability: b.retrievability,
				lastRecall: b.last_recall ?? undefined,
				recallCount: b.recall_count,
				hasConflicts: b.has_conflicts === 1,
				conflictEventIds: b.conflict_event_ids ? JSON.parse(b.conflict_event_ids) : undefined,
			} as CurrentBelief;
		});
	}

	forget(eventId: string, reason: string): void {
		const now = Date.now();

		this.db
			.prepare(`
      INSERT INTO memory_events (
        event_id, namespace, event_type, agent_id, content, content_hash,
        memory_type, version_vector, confidence, evidence_count,
        valid_from, recorded_at, difficulty, stability, embedding_model,
        source_tier, tags
      )
      SELECT
        ?, namespace, 'retract', ?, ?, content_hash,
        memory_type, version_vector, 0, 0, ?, ?, difficulty, stability,
        embedding_model, source_tier, '[]'
      FROM memory_events WHERE event_id = ?
    `)
			.run(ulid(), this.agentId, `Retracted: ${reason}`, now, now, eventId);

		this.db.prepare("DELETE FROM current_beliefs WHERE event_id = ?").run(eventId);
	}

	history(subject: string, namespace?: string): MemoryEvent[] {
		const ns = namespace ?? this.namespace;
		const subjectHash = this.hash(subject);

		const rows = this.db
			.prepare(`
      SELECT * FROM memory_events
      WHERE namespace = ? AND subject_hash = ?
      ORDER BY recorded_at DESC
    `)
			.all(ns, subjectHash) as Array<Record<string, unknown>>;

		return rows.map((r) => ({
			eventId: r.event_id as string,
			namespace: r.namespace as string,
			eventType: r.event_type as "assert" | "retract" | "reinforce",
			agentId: r.agent_id as string,
			content: r.content as string,
			contentHash: r.content_hash as string,
			memoryType: r.memory_type as MemoryType,
			subject: r.subject as string | undefined,
			subjectHash: r.subject_hash as string | undefined,
			versionVector: JSON.parse(r.version_vector as string),
			confidence: r.confidence as number,
			evidenceCount: r.evidence_count as number,
			validFrom: r.valid_from as number,
			recordedAt: r.recorded_at as number,
			difficulty: r.difficulty as number,
			stability: r.stability as number,
			embeddingModel: r.embedding_model as string,
			sourceTier: r.source_tier as SourceTier,
			tags: JSON.parse(r.tags as string),
		}));
	}

	conflicts(namespace?: string): ConflictPair[] {
		const ns = namespace ?? this.namespace;

		const rows = this.db
			.prepare(`
      SELECT
        e1.subject_hash,
        e1.event_id as event_id_a,
        e2.event_id as event_id_b,
        e1.content as content_a,
        e2.content as content_b,
        e1.agent_id as agent_a,
        e2.agent_id as agent_b,
        e1.confidence as confidence_a,
        e2.confidence as confidence_b,
        e1.recorded_at as recorded_at_a,
        e2.recorded_at as recorded_at_b
      FROM current_beliefs cb
      JOIN memory_events e1 ON cb.event_id = e1.event_id
      JOIN memory_events e2 ON cb.conflict_event_ids LIKE '%' || e2.event_id || '%'
      WHERE cb.namespace = ? AND cb.has_conflicts = 1
    `)
			.all(ns) as ConflictPair[];

		return rows;
	}

	resolve(conflictId: string, winnerId: string, reason: string): void {
		const now = Date.now();

		this.db
			.prepare(`
      INSERT INTO memory_events (
        event_id, namespace, event_type, agent_id, content, content_hash,
        memory_type, version_vector, confidence, evidence_count,
        valid_from, recorded_at, difficulty, stability, embedding_model,
        source_tier, tags
      )
      SELECT
        ?, namespace, 'assert', ?, content || ' [resolution: ' || ? || ']',
        content_hash, memory_type, version_vector, confidence, evidence_count,
        ?, ?, difficulty, stability, embedding_model, source_tier, tags
      FROM memory_events WHERE event_id = ?
    `)
			.run(ulid(), this.agentId, reason, now, now, winnerId);

		this.db
			.prepare(`
      UPDATE current_beliefs
      SET has_conflicts = 0, conflict_event_ids = NULL
      WHERE event_id = ?
    `)
			.run(conflictId);
	}

	stats(namespace?: string): MemoryHealth {
		const ns = namespace ?? this.namespace;

		this.refreshRetrievabilities(ns);

		const total = this.db.prepare("SELECT COUNT(*) as count FROM current_beliefs WHERE namespace = ?").get(ns) as {
			count: number;
		};

		const byType = this.db
			.prepare(`
      SELECT memory_type, COUNT(*) as count
      FROM current_beliefs WHERE namespace = ?
      GROUP BY memory_type
    `)
			.all(ns) as Array<{ memory_type: string; count: number }>;

		const avgR = this.db
			.prepare("SELECT AVG(retrievability) as avg FROM current_beliefs WHERE namespace = ?")
			.get(ns) as { avg: number | null };

		const conflictCount = this.db
			.prepare("SELECT COUNT(*) as count FROM current_beliefs WHERE namespace = ? AND has_conflicts = 1")
			.get(ns) as { count: number };

		const lowR = this.db
			.prepare("SELECT COUNT(*) as count FROM current_beliefs WHERE namespace = ? AND retrievability < 0.1")
			.get(ns) as { count: number };

		return {
			total: total.count,
			byType: {
				episodic: byType.find((t) => t.memory_type === "episodic")?.count ?? 0,
				factual: byType.find((t) => t.memory_type === "factual")?.count ?? 0,
				procedural: byType.find((t) => t.memory_type === "procedural")?.count ?? 0,
			},
			avgRetrievability: avgR.avg ?? 0,
			conflicts: conflictCount.count,
			lowRCount: lowR.count,
		};
	}

	consolidate(namespace?: string): ConsolidationResult {
		const ns = namespace ?? this.namespace;

		this.refreshRetrievabilities(ns);

		const updated = this.db.prepare("SELECT COUNT(*) as count FROM current_beliefs WHERE namespace = ?").get(ns) as {
			count: number;
		};

		const archived = this.db
			.prepare(`
      SELECT COUNT(*) as count FROM current_beliefs
      WHERE namespace = ? AND retrievability < 0.01 AND memory_type = 'episodic'
    `)
			.get(ns) as { count: number };

		const conflictCount = this.db
			.prepare("SELECT COUNT(*) as count FROM current_beliefs WHERE namespace = ? AND has_conflicts = 1")
			.get(ns) as { count: number };

		this.db.exec("ANALYZE");

		return {
			updated: updated.count,
			archived: archived.count,
			pruned: 0,
			conflicts: conflictCount.count,
		};
	}

	rebuildProjection(namespace?: string): void {
		const ns = namespace ?? this.namespace;

		this.db.prepare("DELETE FROM current_beliefs WHERE namespace = ?").run(ns);

		const events = this.db
			.prepare(`
      SELECT * FROM memory_events
      WHERE namespace = ? AND event_type = 'assert'
      ORDER BY recorded_at ASC
    `)
			.all(ns) as Array<Record<string, unknown>>;

		for (const e of events) {
			const event: MemoryEvent = {
				eventId: e.event_id as string,
				namespace: e.namespace as string,
				eventType: e.event_type as "assert" | "retract" | "reinforce",
				agentId: e.agent_id as string,
				content: e.content as string,
				contentHash: e.content_hash as string,
				memoryType: e.memory_type as MemoryType,
				subject: e.subject as string | undefined,
				subjectHash: e.subject_hash as string | undefined,
				versionVector: JSON.parse(e.version_vector as string),
				confidence: e.confidence as number,
				evidenceCount: e.evidence_count as number,
				validFrom: e.valid_from as number,
				recordedAt: e.recorded_at as number,
				difficulty: e.difficulty as number,
				stability: e.stability as number,
				embeddingModel: e.embedding_model as string,
				sourceTier: e.source_tier as SourceTier,
				tags: JSON.parse(e.tags as string),
			};
			this.updateProjection(event);
		}
	}

	close(): void {
		this.db.close();
	}

	private updateProjection(event: MemoryEvent, conflictsWith?: string[]): void {
		const now = Date.now();
		const daysSince = this.fsrs.daysSinceTimestamp(event.recordedAt, now);
		const retrievability = this.fsrs.computeRetrievability(event.stability, daysSince);

		if (event.memoryType === "episodic") {
			this.db
				.prepare(`
        INSERT OR REPLACE INTO current_beliefs (
          event_id, namespace, content, memory_type, subject, subject_hash,
          confidence, valid_from, recorded_at, difficulty, stability,
          retrievability, last_recall, recall_count, has_conflicts, conflict_event_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
				.run(
					event.eventId,
					event.namespace,
					event.content,
					event.memoryType,
					event.subject ?? null,
					event.subjectHash ?? null,
					event.confidence,
					event.validFrom,
					event.recordedAt,
					event.difficulty,
					event.stability,
					retrievability,
					null,
					0,
					0,
					null,
				);
		} else {
			const existing = this.db
				.prepare(`
        SELECT event_id FROM current_beliefs
        WHERE namespace = ? AND subject_hash = ?
      `)
				.get(event.namespace, event.subjectHash) as { event_id: string } | undefined;

			if (existing && !conflictsWith) {
				this.db.prepare("DELETE FROM current_beliefs WHERE event_id = ?").run(existing.event_id);
			}

			const hasConflicts = conflictsWith && conflictsWith.length > 0 ? 1 : 0;
			const conflictIds = conflictsWith ? JSON.stringify(conflictsWith) : null;

			this.db
				.prepare(`
        INSERT OR REPLACE INTO current_beliefs (
          event_id, namespace, content, memory_type, subject, subject_hash,
          confidence, valid_from, recorded_at, difficulty, stability,
          retrievability, last_recall, recall_count, has_conflicts, conflict_event_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
				.run(
					event.eventId,
					event.namespace,
					event.content,
					event.memoryType,
					event.subject ?? null,
					event.subjectHash ?? null,
					event.confidence,
					event.validFrom,
					event.recordedAt,
					event.difficulty,
					event.stability,
					retrievability,
					null,
					0,
					hasConflicts,
					conflictIds,
				);
		}
	}

	private refreshRetrievabilities(namespace: string): void {
		const now = Date.now();

		const beliefs = this.db
			.prepare(`
      SELECT event_id, stability, last_recall, recorded_at
      FROM current_beliefs WHERE namespace = ?
    `)
			.all(namespace) as Array<{
			event_id: string;
			stability: number;
			last_recall: number | null;
			recorded_at: number;
		}>;

		for (const b of beliefs) {
			const lastRecall = b.last_recall ?? b.recorded_at;
			const daysSince = this.fsrs.daysSinceTimestamp(lastRecall, now);
			const R = this.fsrs.computeRetrievability(b.stability, daysSince);

			this.db.prepare("UPDATE current_beliefs SET retrievability = ? WHERE event_id = ?").run(R, b.event_id);
		}
	}

	private ftsSearch(query: string, namespace: string, limit: number): string[] {
		const ftsQuery = query
			.split(/\s+/)
			.filter((t) => t.length >= 2)
			.map((t) => `"${t.replace(/"/g, '""')}"`)
			.join(" OR ");

		if (!ftsQuery) return [];

		try {
			const rows = this.db
				.prepare(`
          SELECT f.event_id, bm25(memory_fts) as score
          FROM memory_fts f
          JOIN current_beliefs cb ON f.event_id = cb.event_id
          WHERE memory_fts MATCH ? AND cb.namespace = ?
          ORDER BY score
          LIMIT ?
        `)
				.all(ftsQuery, namespace, limit) as Array<{ event_id: string }>;

			return rows.map((r) => r.event_id);
		} catch {
			return [];
		}
	}

	private async vectorSearch(query: string, namespace: string, limit: number): Promise<string[]> {
		if (!this.embedder) return [];

		try {
			const embedding = await this.embedder.embed(query);

			const rows = this.db
				.prepare(`
          SELECT m.event_id, distance
          FROM memory_vectors v
          JOIN memory_vector_map m ON v.rowid = m.rowid
          JOIN current_beliefs cb ON m.event_id = cb.event_id
          WHERE cb.namespace = ?
          ORDER BY distance
          LIMIT ?
        `)
				.bind(namespace, limit)
				.all(embedding) as Array<{ event_id: string }>;

			return rows.map((r) => r.event_id);
		} catch {
			return [];
		}
	}

	private recordRecall(eventId: string): void {
		const now = Date.now();

		const belief = this.db
			.prepare(
				"SELECT stability, difficulty, retrievability, recall_count, memory_type FROM current_beliefs WHERE event_id = ?",
			)
			.get(eventId) as {
			stability: number;
			difficulty: number;
			retrievability: number;
			recall_count: number;
			memory_type: string;
		};

		const newStability = this.fsrs.updateStability(
			belief.stability,
			belief.difficulty,
			belief.retrievability,
			belief.memory_type as MemoryType,
		);

		this.db
			.prepare(`
      UPDATE current_beliefs
      SET stability = ?, last_recall = ?, recall_count = recall_count + 1, retrievability = 1.0
      WHERE event_id = ?
    `)
			.run(newStability, now, eventId);

		this.db
			.prepare(`
      INSERT INTO memory_events (
        event_id, namespace, event_type, agent_id, content, content_hash,
        memory_type, subject, subject_hash, version_vector, confidence,
        evidence_count, valid_from, recorded_at, difficulty, stability,
        embedding_model, source_tier, tags
      )
      SELECT
        ?, namespace, 'reinforce', ?, content, content_hash,
        memory_type, subject, subject_hash, version_vector, confidence,
        evidence_count, valid_from, ?, difficulty, ?,
        embedding_model, source_tier, tags
      FROM memory_events WHERE event_id = ?
    `)
			.run(ulid(), this.agentId, now, newStability, eventId);
	}
}
