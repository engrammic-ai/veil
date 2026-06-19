/**
 * Staleness detection for recalled context items.
 * Compares mtime/hash of referenced files against values captured at storage time.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ContextItem } from "./types.ts";

export interface StalenessCheck {
	isStale: boolean;
	reason?: "mtime_changed" | "hash_changed" | "file_deleted";
}

export function getResourceMetadata(filePath: string): { mtime: number; hash: string } | null {
	try {
		const stat = statSync(filePath);
		const content = readFileSync(filePath, "utf-8");
		const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
		return { mtime: stat.mtimeMs, hash };
	} catch {
		return null;
	}
}

function resolveResourcePath(item: ContextItem): string | null {
	const fileTag = item.tags.find((t) => t.startsWith("file:"));
	if (fileTag) return fileTag.slice(5);
	const pathTag = item.tags.find((t) => t.includes("/") && t.includes("."));
	return pathTag ?? null;
}

export function checkStaleness(item: ContextItem): StalenessCheck {
	if (item.resourceMtime === undefined && item.resourceHash === undefined) {
		return { isStale: false };
	}

	const resourcePath = resolveResourcePath(item);
	if (!resourcePath) return { isStale: false };

	const current = getResourceMetadata(resourcePath);
	if (!current) {
		return { isStale: true, reason: "file_deleted" };
	}

	if (item.resourceMtime !== undefined && current.mtime === item.resourceMtime) {
		return { isStale: false };
	}

	if (item.resourceHash !== undefined && current.hash !== item.resourceHash) {
		return { isStale: true, reason: "hash_changed" };
	}

	// mtime changed but hash same (touch) — not actually stale
	return { isStale: false };
}

export function markStaleItems(items: ContextItem[]): ContextItem[] {
	return items.map((item) => {
		if (item.resourceMtime === undefined && item.resourceHash === undefined) return item;
		const { isStale } = checkStaleness(item);
		if (isStale === item.isStale) return item;
		return { ...item, isStale };
	});
}
