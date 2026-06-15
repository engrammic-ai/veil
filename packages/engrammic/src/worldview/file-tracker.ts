/**
 * Tracks file modification times in SQLite so the worldview can skip
 * re-parsing files whose content hasn't changed.
 *
 * Each row records:
 *   - file            : absolute path
 *   - mtime           : last observed mtimeMs (milliseconds)
 *   - symbols_updated_at : when we last wrote symbols for this file
 */

import fs from "node:fs";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Schema (also referenced by cache.ts)
// ---------------------------------------------------------------------------

export const FILE_MTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS file_mtime (
  file TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  symbols_updated_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileMtimeRow {
	file: string;
	mtime: number;
	symbols_updated_at: number;
}

// ---------------------------------------------------------------------------
// FileTracker
// ---------------------------------------------------------------------------

export class FileTracker {
	private readonly db: Database.Database;

	private stmtGet: Database.Statement;
	private stmtUpsert: Database.Statement;
	private stmtDelete: Database.Statement;
	private stmtGetAll: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.initSchema();

		this.stmtGet = this.db.prepare("SELECT file, mtime, symbols_updated_at FROM file_mtime WHERE file = ?");

		this.stmtUpsert = this.db.prepare(`
			INSERT INTO file_mtime (file, mtime, symbols_updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(file) DO UPDATE SET
			  mtime = excluded.mtime,
			  symbols_updated_at = excluded.symbols_updated_at
		`);

		this.stmtDelete = this.db.prepare("DELETE FROM file_mtime WHERE file = ?");

		this.stmtGetAll = this.db.prepare("SELECT file, mtime, symbols_updated_at FROM file_mtime");
	}

	/**
	 * Open a standalone FileTracker backed by its own DB file.
	 * Convenient for tests and tools that don't share the main cache DB.
	 */
	static open(dbPath: string): FileTracker {
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		return new FileTracker(db);
	}

	/**
	 * Read mtimeMs for the given file from disk.
	 * Returns null if the file does not exist or stat fails.
	 */
	getFileMtime(filePath: string): number | null {
		try {
			return fs.statSync(filePath).mtimeMs;
		} catch {
			return null;
		}
	}

	/**
	 * Return true if the file's current mtime on disk differs from
	 * `lastKnownMtime`. Also returns true when the file cannot be stat-ed
	 * (treat missing file as changed so callers can clean up gracefully).
	 */
	hasFileChanged(filePath: string, lastKnownMtime: number): boolean {
		const current = this.getFileMtime(filePath);
		if (current === null) return true;
		return current !== lastKnownMtime;
	}

	/**
	 * Return the tracked row for the file, or null if not yet tracked.
	 */
	getRow(filePath: string): FileMtimeRow | null {
		const row = this.stmtGet.get(filePath) as FileMtimeRow | undefined;
		return row ?? null;
	}

	/**
	 * Record (or update) the mtime for a file, with the current time as
	 * `symbols_updated_at`.
	 */
	recordMtime(filePath: string, mtime: number, symbolsUpdatedAt: number = Date.now()): void {
		this.stmtUpsert.run(filePath, mtime, symbolsUpdatedAt);
	}

	/**
	 * Remove the tracked row for a file (e.g. when the file is deleted).
	 */
	removeFile(filePath: string): void {
		this.stmtDelete.run(filePath);
	}

	/**
	 * Return all tracked files and their mtimes.
	 */
	getAllRows(): FileMtimeRow[] {
		return this.stmtGetAll.all() as FileMtimeRow[];
	}

	close(): void {
		this.db.close();
	}

	// -------------------------------------------------------------------------
	// Private
	// -------------------------------------------------------------------------

	private initSchema(): void {
		this.db.exec(FILE_MTIME_SCHEMA);
	}
}
