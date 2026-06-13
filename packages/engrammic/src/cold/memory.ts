/**
 * In-memory ColdStore - for testing and ephemeral sessions.
 * No persistence, everything lost on restart.
 */

import { randomUUID } from "node:crypto";
import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities } from "./interface.ts";

export class MemoryColdStore implements ColdStore {
	private items: Map<string, ContextItem> = new Map();

	readonly capabilities: ColdStoreCapabilities = {
		semantic: false,
		temporal: false,
		provenance: false,
	};

	async demote(item: ContextItem): Promise<string> {
		const pointer = `mem_${randomUUID()}`;
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

	async close(): Promise<void> {
		this.items.clear();
	}

	// Utility for testing
	size(): number {
		return this.items.size;
	}
}
