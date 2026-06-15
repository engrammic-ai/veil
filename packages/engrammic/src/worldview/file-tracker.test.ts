/**
 * Tests for FileTracker (file-tracker.ts) and checkAndUpdateFile (incremental-update.ts).
 *
 * getFileMtime is spied on the instance rather than mocking node:fs globally,
 * which avoids ESM import-binding issues with vitest.
 * web-tree-sitter is mocked so symbol extraction works without WASM.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTracker } from "./file-tracker.ts";
import { checkAndUpdateFile } from "./incremental-update.ts";
import { TreeSitterParser } from "./parser.ts";
import { SymbolStore } from "./symbol-store.ts";

// ---------------------------------------------------------------------------
// Mock web-tree-sitter (same pattern as symbols.test.ts)
// ---------------------------------------------------------------------------

vi.mock("web-tree-sitter", () => {
	const mockLanguage = { name: "typescript" };
	const mockParser = {
		setLanguage: vi.fn(),
		parse: vi.fn().mockReturnValue(null), // default: unsupported — returns no symbols
	};
	// MockParser must be the default export itself (used as `new P()` in parser.ts).
	// We return the instance object from the constructor so `new MockParser()` gives mockParser.
	const MockParser = Object.assign(
		function MockParser(this: unknown) {
			return mockParser;
		},
		{
			init: vi.fn().mockResolvedValue(undefined),
			Language: { load: vi.fn().mockResolvedValue(mockLanguage) },
		},
	);
	return {
		default: MockParser,
		__mockParser: mockParser,
		__mockLanguage: mockLanguage,
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	return db;
}

// ---------------------------------------------------------------------------
// FileTracker tests
// ---------------------------------------------------------------------------

describe("FileTracker", () => {
	let db: Database.Database;
	let tracker: FileTracker;

	beforeEach(() => {
		db = makeDb();
		tracker = new FileTracker(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates file_mtime table on construction", () => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_mtime'").get();
		expect(row).toBeDefined();
	});

	describe("getFileMtime", () => {
		it("returns mtimeMs when stat succeeds", () => {
			vi.spyOn(tracker, "getFileMtime").mockReturnValueOnce(1_000_000);
			expect(tracker.getFileMtime("/foo/bar.ts")).toBe(1_000_000);
		});

		it("returns null when stat throws (via real method on nonexistent path)", () => {
			// Use a path that definitely doesn't exist
			const result = tracker.getFileMtime("/absolutely/nonexistent/path/that/cannot/exist.ts");
			expect(result).toBeNull();
		});
	});

	describe("hasFileChanged", () => {
		it("returns false when mtime matches", () => {
			vi.spyOn(tracker, "getFileMtime").mockReturnValue(5000);
			expect(tracker.hasFileChanged("/a.ts", 5000)).toBe(false);
		});

		it("returns true when mtime differs", () => {
			vi.spyOn(tracker, "getFileMtime").mockReturnValue(9999);
			expect(tracker.hasFileChanged("/a.ts", 5000)).toBe(true);
		});

		it("returns true when stat fails (getFileMtime returns null)", () => {
			vi.spyOn(tracker, "getFileMtime").mockReturnValue(null);
			expect(tracker.hasFileChanged("/gone.ts", 1234)).toBe(true);
		});
	});

	describe("recordMtime / getRow", () => {
		it("inserts a new row", () => {
			tracker.recordMtime("/src/foo.ts", 12345, 99999);
			const row = tracker.getRow("/src/foo.ts");
			expect(row).not.toBeNull();
			expect(row!.file).toBe("/src/foo.ts");
			expect(row!.mtime).toBe(12345);
			expect(row!.symbols_updated_at).toBe(99999);
		});

		it("updates an existing row on conflict", () => {
			tracker.recordMtime("/src/foo.ts", 100, 200);
			tracker.recordMtime("/src/foo.ts", 300, 400);
			const row = tracker.getRow("/src/foo.ts");
			expect(row!.mtime).toBe(300);
			expect(row!.symbols_updated_at).toBe(400);
		});

		it("returns null for untracked file", () => {
			expect(tracker.getRow("/unknown.ts")).toBeNull();
		});

		it("uses Date.now() as default symbols_updated_at", () => {
			const before = Date.now();
			tracker.recordMtime("/t.ts", 999);
			const after = Date.now();
			const row = tracker.getRow("/t.ts");
			expect(row!.symbols_updated_at).toBeGreaterThanOrEqual(before);
			expect(row!.symbols_updated_at).toBeLessThanOrEqual(after);
		});
	});

	describe("removeFile", () => {
		it("deletes the row", () => {
			tracker.recordMtime("/a.ts", 1, 2);
			tracker.removeFile("/a.ts");
			expect(tracker.getRow("/a.ts")).toBeNull();
		});

		it("is a no-op for unknown file", () => {
			expect(() => tracker.removeFile("/unknown.ts")).not.toThrow();
		});
	});

	describe("getAllRows", () => {
		it("returns all tracked files", () => {
			tracker.recordMtime("/a.ts", 1, 10);
			tracker.recordMtime("/b.ts", 2, 20);
			const rows = tracker.getAllRows();
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.file).sort()).toEqual(["/a.ts", "/b.ts"]);
		});

		it("returns empty array when no files tracked", () => {
			expect(tracker.getAllRows()).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// checkAndUpdateFile tests
// ---------------------------------------------------------------------------

describe("checkAndUpdateFile", () => {
	let db: Database.Database;
	let tracker: FileTracker;
	let symbolStore: SymbolStore;
	let parser: TreeSitterParser;

	beforeEach(async () => {
		db = makeDb();
		tracker = new FileTracker(db);
		symbolStore = new SymbolStore(db);
		parser = new TreeSitterParser();
		await parser.init();
	});

	afterEach(() => {
		db.close();
	});

	it("skips when getFileMtime returns null (file missing)", async () => {
		vi.spyOn(tracker, "getFileMtime").mockReturnValue(null);

		const result = await checkAndUpdateFile("/gone.ts", "", parser, symbolStore, tracker);
		expect(result.skipped).toBe(true);
		expect(result.mtime).toBeNull();
		expect(result.symbolCount).toBe(0);
	});

	it("processes file when not yet tracked", async () => {
		vi.spyOn(tracker, "getFileMtime").mockReturnValue(10_000);

		// .xyz extension → no language → no symbols (parse returns null), but file is processed
		const result = await checkAndUpdateFile("/new.xyz", "content", parser, symbolStore, tracker);
		expect(result.skipped).toBe(false);
		expect(result.mtime).toBe(10_000);
		expect(result.symbolCount).toBe(0);

		// mtime should now be recorded
		const row = tracker.getRow("/new.xyz");
		expect(row).not.toBeNull();
		expect(row!.mtime).toBe(10_000);
	});

	it("skips when mtime unchanged since last index", async () => {
		const MTIME = 5_000;
		vi.spyOn(tracker, "getFileMtime").mockReturnValue(MTIME);

		// First pass — index the file
		await checkAndUpdateFile("/stable.ts", "code", parser, symbolStore, tracker);

		// Second pass — same mtime
		const result = await checkAndUpdateFile("/stable.ts", "code", parser, symbolStore, tracker);
		expect(result.skipped).toBe(true);
		expect(result.mtime).toBe(MTIME);
	});

	it("re-processes file when mtime changes", async () => {
		const getMtimeSpy = vi.spyOn(tracker, "getFileMtime");

		// First pass: mtime = 1000
		getMtimeSpy.mockReturnValue(1_000);
		await checkAndUpdateFile("/changing.ts", "v1", parser, symbolStore, tracker);

		// Second pass: mtime changed to 2000
		getMtimeSpy.mockReturnValue(2_000);
		const result = await checkAndUpdateFile("/changing.ts", "v2", parser, symbolStore, tracker);
		expect(result.skipped).toBe(false);
		expect(result.mtime).toBe(2_000);
	});

	it("updates the mtime record after successful extraction", async () => {
		vi.spyOn(tracker, "getFileMtime").mockReturnValue(42_000);

		await checkAndUpdateFile("/x.ts", "src", parser, symbolStore, tracker);

		const row = tracker.getRow("/x.ts");
		expect(row).not.toBeNull();
		expect(row!.mtime).toBe(42_000);
		// symbols_updated_at should be a plausible timestamp
		expect(row!.symbols_updated_at).toBeGreaterThan(0);
	});

	it("does not re-record mtime when file stat fails mid-call", async () => {
		// File existed at first tracking
		const getMtimeSpy = vi.spyOn(tracker, "getFileMtime");
		getMtimeSpy.mockReturnValue(100);
		await checkAndUpdateFile("/transient.ts", "code", parser, symbolStore, tracker);

		// File now gone
		getMtimeSpy.mockReturnValue(null);
		const result = await checkAndUpdateFile("/transient.ts", "code", parser, symbolStore, tracker);
		expect(result.skipped).toBe(true);
		expect(result.mtime).toBeNull();

		// The row still has the old mtime (we didn't overwrite with null)
		const row = tracker.getRow("/transient.ts");
		expect(row!.mtime).toBe(100);
	});
});
