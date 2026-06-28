/**
 * Mock ColdStore - for testing only.
 * No persistence, everything lost on restart.
 */

import { randomUUID } from "node:crypto";
import type { ContextItem } from "../types.ts";
import { AliasTable } from "./alias-table.ts";
import type { EntityRef } from "./entity.ts";
import { extractFingerprint, fingerprintSimilarity } from "./entity.ts";
import type { ColdStore, ColdStoreCapabilities, ListOptions, ListResult } from "./interface.ts";

/**
 * Minimal glob matching: supports *, ?, [abc], [!abc].
 * No ** or path-style matching — tags are flat strings.
 */
function globMatch(pattern: string, str: string, ignoreCase = false): boolean {
	if (ignoreCase) {
		pattern = pattern.toLowerCase();
		str = str.toLowerCase();
	}

	const p = pattern;
	const s = str;
	let pi = 0;
	let si = 0;
	let starPi = -1;
	let starSi = -1;

	while (si < s.length) {
		if (pi < p.length && p[pi] === "*") {
			starPi = pi;
			starSi = si;
			pi++;
		} else if (pi < p.length && matchOne(p, pi, s[si])) {
			pi = advancePi(p, pi);
			si++;
		} else if (starPi !== -1) {
			// Backtrack: star consumes one more char
			starSi++;
			pi = starPi + 1;
			si = starSi;
		} else {
			return false;
		}
	}

	// Consume trailing stars
	while (pi < p.length && p[pi] === "*") pi++;

	return pi === p.length;
}

/** Returns true if pattern char(s) at pi match ch. */
function matchOne(pattern: string, pi: number, ch: string): boolean {
	if (pattern[pi] === "?") return true;
	if (pattern[pi] === "[") {
		const close = pattern.indexOf("]", pi + 1);
		if (close === -1) return pattern[pi] === ch; // malformed, treat as literal
		const inner = pattern.slice(pi + 1, close);
		const negate = inner[0] === "!";
		const chars = negate ? inner.slice(1) : inner;
		const found = chars.includes(ch);
		return negate ? !found : found;
	}
	return pattern[pi] === ch;
}

/** Advance pi past the current token (handles [abc] as a single token). */
function advancePi(pattern: string, pi: number): number {
	if (pattern[pi] === "[") {
		const close = pattern.indexOf("]", pi + 1);
		return close === -1 ? pi + 1 : close + 1;
	}
	return pi + 1;
}

export class MockColdStore implements ColdStore {
	private items: Map<string, ContextItem> = new Map();
	private entityRegistry: Map<string, EntityRef> = new Map();
	private aliasTable: AliasTable = new AliasTable();

	readonly capabilities: ColdStoreCapabilities = {
		semantic: false,
		temporal: false,
		provenance: false,
		glob: true,
		listing: true,
		entityResolution: true,
	};

	async demote(item: ContextItem): Promise<string> {
		const pointer = `mock_${randomUUID()}`;
		this.items.set(pointer, { ...item, kgPointer: pointer });
		return pointer;
	}

	async fetch(pointer: string): Promise<ContextItem | null> {
		const item = this.items.get(pointer);
		if (!item) return null;

		// Update access tracking
		item.lastAccess = Date.now();
		item.accessCount++;

		return { ...item };
	}

	async delete(pointer: string): Promise<void> {
		this.items.delete(pointer);
	}

	async exists(pointer: string): Promise<boolean> {
		return this.items.has(pointer);
	}

	async count(): Promise<number> {
		return this.items.size;
	}

	async query(text: string, tags: string[], limit: number): Promise<ContextItem[]> {
		if (text === "*") {
			const result = await this.list({ tags, limit, sort: "recent" });
			return result.items;
		}
		// MockColdStore has no semantic search — return empty
		return [];
	}

	async list(options: ListOptions = {}): Promise<ListResult> {
		const { ignoreCase = false } = options;

		let items = [...this.items.values()];

		// Apply tag globs
		if (options.tags?.length) {
			items = items.filter((item) =>
				options.tags!.every((pattern) => item.tags.some((tag) => globMatch(pattern, tag, ignoreCase))),
			);
		}

		// Sort
		items.sort((a, b) => {
			if (options.sort === "oldest") return a.createdAt - b.createdAt;
			return b.lastAccess - a.lastAccess; // "recent" default
		});

		// Paginate
		const start = options.cursor ? parseInt(options.cursor, 10) : 0;
		const limit = options.limit ?? 100;
		const page = items.slice(start, start + limit);

		return {
			items: page,
			nextCursor: start + limit < items.length ? String(start + limit) : undefined,
			total: items.length,
		};
	}

	async fetchByPrefix(prefix: string, limit = 100): Promise<ContextItem[]> {
		return [...this.items.values()].filter((item) => item.id.startsWith(prefix)).slice(0, limit);
	}

	async resolveEntities(items: ContextItem[]): Promise<{
		resolved: ContextItem[];
		needsReview: Array<{ item: ContextItem; candidates: EntityRef[] }>;
	}> {
		const fingerprints = items.map((item) => extractFingerprint(item.content));

		// Group by main entity name (most frequent term from fingerprint)
		const groups = new Map<string, number[]>();
		for (let i = 0; i < items.length; i++) {
			const name = fingerprints[i][0] ?? "__unknown__";
			if (!groups.has(name)) groups.set(name, []);
			groups.get(name)!.push(i);
		}

		const resolved: ContextItem[] = [];
		const needsReview: Array<{ item: ContextItem; candidates: EntityRef[] }> = [];

		for (const [, groupIdxs] of groups) {
			if (groupIdxs.length === 1) {
				const idx = groupIdxs[0];
				const entity = await this.createEntity({
					canonicalName: fingerprints[idx][0] ?? "__unknown__",
					aliases: [],
					fingerprint: fingerprints[idx],
					sources: [],
				});
				resolved.push({ ...items[idx], entityRef: entity.id });
				continue;
			}

			// Union-find clustering within name group
			const n = groupIdxs.length;
			const parent = Array.from({ length: n }, (_, i) => i);

			const find = (x: number): number => {
				if (parent[x] !== x) parent[x] = find(parent[x]);
				return parent[x];
			};
			const union = (x: number, y: number) => {
				parent[find(x)] = find(y);
			};

			const ambiguous = new Set<number>();

			for (let i = 0; i < n; i++) {
				for (let j = i + 1; j < n; j++) {
					const sim = fingerprintSimilarity(fingerprints[groupIdxs[i]], fingerprints[groupIdxs[j]]);
					if (sim > 0.8) {
						union(i, j);
					} else if (sim >= 0.5) {
						ambiguous.add(i);
						ambiguous.add(j);
					}
					// < 0.5: distinct entities, remain in separate clusters
				}
			}

			// Create one entity per cluster root
			const clusterToEntity = new Map<number, EntityRef>();
			for (let i = 0; i < n; i++) {
				const root = find(i);
				if (!clusterToEntity.has(root)) {
					const fp = fingerprints[groupIdxs[root]];
					const entity = await this.createEntity({
						canonicalName: fp[0] ?? "__unknown__",
						aliases: [],
						fingerprint: fp,
						sources: [],
					});
					clusterToEntity.set(root, entity);
				}
			}

			const allCandidates = [...clusterToEntity.values()];

			for (let i = 0; i < n; i++) {
				const item = items[groupIdxs[i]];
				if (ambiguous.has(i)) {
					needsReview.push({ item, candidates: allCandidates });
				} else {
					const entity = clusterToEntity.get(find(i))!;
					resolved.push({ ...item, entityRef: entity.id });
				}
			}
		}

		return { resolved, needsReview };
	}

	async addEntityAlias(variant: string, canonicalId: string): Promise<void> {
		this.aliasTable.addAlias(variant, canonicalId);
	}

	async getEntity(id: string): Promise<EntityRef | null> {
		return this.entityRegistry.get(id) ?? null;
	}

	async createEntity(entity: Omit<EntityRef, "id">): Promise<EntityRef> {
		const id = `entity_${randomUUID()}`;
		const fullEntity: EntityRef = { id, ...entity };
		this.entityRegistry.set(id, fullEntity);
		return { ...fullEntity };
	}

	async close(): Promise<void> {
		this.items.clear();
	}

	// Utility for testing
	size(): number {
		return this.items.size;
	}
}
