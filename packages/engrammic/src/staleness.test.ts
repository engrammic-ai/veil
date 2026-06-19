import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStaleness, getResourceMetadata, markStaleItems } from "./staleness.ts";
import type { ContextItem } from "./types.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "test_item",
		content: "some content",
		contentHash: "abc123",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
		decayScore: 0,
		cognitiveWeight: 0,
		stability: 0.5,
		difficulty: 0.5,
		type: "episodic",
		tags: [],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

describe("getResourceMetadata", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "staleness-test-"));
		filePath = join(dir, "test.ts");
		writeFileSync(filePath, "export const x = 1;\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true });
	});

	it("returns mtime and hash for existing file", () => {
		const meta = getResourceMetadata(filePath);
		expect(meta).not.toBeNull();
		expect(typeof meta!.mtime).toBe("number");
		expect(meta!.hash).toHaveLength(16);
	});

	it("returns null for non-existent file", () => {
		expect(getResourceMetadata(join(dir, "nonexistent.ts"))).toBeNull();
	});

	it("returns different hash when content changes", () => {
		const before = getResourceMetadata(filePath)!;
		writeFileSync(filePath, "export const x = 2;\n");
		const after = getResourceMetadata(filePath)!;
		expect(before.hash).not.toBe(after.hash);
	});
});

describe("checkStaleness", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "staleness-check-"));
		filePath = join(dir, "store.ts");
		writeFileSync(filePath, "export const v = 1;\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true });
	});

	it("returns not stale when item has no resource metadata", () => {
		const item = makeItem({ tags: [`file:${filePath}`] });
		expect(checkStaleness(item).isStale).toBe(false);
	});

	it("returns not stale when file unchanged (same mtime and hash)", () => {
		const meta = getResourceMetadata(filePath)!;
		const item = makeItem({
			tags: [`file:${filePath}`],
			resourceMtime: meta.mtime,
			resourceHash: meta.hash,
		});
		expect(checkStaleness(item).isStale).toBe(false);
	});

	it("returns stale with reason hash_changed when content changed", () => {
		const meta = getResourceMetadata(filePath)!;
		writeFileSync(filePath, "export const v = 999;\n");
		const item = makeItem({
			tags: [`file:${filePath}`],
			resourceMtime: meta.mtime,
			resourceHash: meta.hash,
		});
		const result = checkStaleness(item);
		expect(result.isStale).toBe(true);
		expect(result.reason).toBe("hash_changed");
	});

	it("returns stale with reason file_deleted when file is gone", () => {
		const meta = getResourceMetadata(filePath)!;
		rmSync(filePath);
		const item = makeItem({
			tags: [`file:${filePath}`],
			resourceMtime: meta.mtime,
			resourceHash: meta.hash,
		});
		const result = checkStaleness(item);
		expect(result.isStale).toBe(true);
		expect(result.reason).toBe("file_deleted");
	});

	it("returns not stale when mtime changed but hash is same (touch)", () => {
		const meta = getResourceMetadata(filePath)!;
		const item = makeItem({
			tags: [`file:${filePath}`],
			resourceMtime: meta.mtime - 5000,
			resourceHash: meta.hash,
		});
		const result = checkStaleness(item);
		expect(result.isStale).toBe(false);
	});

	it("returns not stale when item has no file tag", () => {
		const item = makeItem({ tags: ["episodic"], resourceMtime: 12345, resourceHash: "deadbeef" });
		expect(checkStaleness(item).isStale).toBe(false);
	});
});

describe("markStaleItems", () => {
	let dir: string;
	let filePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "staleness-mark-"));
		filePath = join(dir, "fsrs.ts");
		writeFileSync(filePath, "original\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true });
	});

	it("marks changed items as stale", () => {
		const meta = getResourceMetadata(filePath)!;
		writeFileSync(filePath, "changed\n");
		const item = makeItem({
			tags: [`file:${filePath}`],
			resourceMtime: meta.mtime,
			resourceHash: meta.hash,
		});
		const [marked] = markStaleItems([item]);
		expect(marked.isStale).toBe(true);
	});

	it("leaves unchanged items as not stale", () => {
		const meta = getResourceMetadata(filePath)!;
		const item = makeItem({
			tags: [`file:${filePath}`],
			resourceMtime: meta.mtime,
			resourceHash: meta.hash,
		});
		const [marked] = markStaleItems([item]);
		expect(marked.isStale).toBe(false);
	});

	it("preserves items with no resource metadata unchanged", () => {
		const item = makeItem({ tags: ["procedural"] });
		const [marked] = markStaleItems([item]);
		expect(marked.isStale).toBe(undefined);
	});
});
