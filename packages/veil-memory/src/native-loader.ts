/**
 * SQLite loader for veil-memory.
 *
 * Uses bun:sqlite when running in Bun (runtime or compiled binary),
 * falls back to better-sqlite3 for Node.js (development with tsx).
 *
 * This abstraction handles the slight API differences between the two.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "module";
import { arch, platform } from "process";

// Detect if running in Bun
function isBun(): boolean {
	return typeof (globalThis as any).Bun !== "undefined";
}

// Get the sqlite-vec extension path for the current platform
function getSqliteVecPath(): string | null {
	const os = platform === "win32" ? "windows" : platform;
	const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
	const fileName = `vec0.${suffix}`;
	const nodeRequire = createRequire(import.meta.url);

	// ponytail: try native arch first, fall back to x64 on arm64 (emulation works on Win/Mac)
	const archsToTry = arch === "arm64" ? ["arm64", "x64"] : [arch];

	for (const tryArch of archsToTry) {
		const packageName = `sqlite-vec-${os}-${tryArch}`;
		try {
			return nodeRequire.resolve(`${packageName}/${fileName}`);
		} catch {
			// Not found, try next
		}
	}
	return null;
}

let databaseCache: typeof BetterSqlite3 | null = null;

/**
 * Load the SQLite database constructor.
 * Returns bun:sqlite's Database in Bun, better-sqlite3's in Node.
 */
export function loadBetterSqlite3(): typeof BetterSqlite3 {
	if (databaseCache) return databaseCache;

	if (isBun()) {
		// Use bun:sqlite - dynamically import to avoid Node.js errors
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { Database } = require("bun:sqlite") as { Database: any };

		// Wrap to add pragma() method for compatibility
		const WrappedDatabase = function (this: any, filename: string, options?: any) {
			const db = new Database(filename, options);

			// Add pragma() method that better-sqlite3 has
			db.pragma = function (pragma: string) {
				// Parse "key = value" format
				const result = this.exec(`PRAGMA ${pragma}`);
				return result;
			};

			return db;
		} as unknown as typeof BetterSqlite3;

		// Copy static properties
		Object.setPrototypeOf(WrappedDatabase, Database);
		WrappedDatabase.prototype = Database.prototype;

		databaseCache = WrappedDatabase;
	} else {
		// Use better-sqlite3 in Node.js
		const nodeRequire = createRequire(import.meta.url);
		databaseCache = nodeRequire("better-sqlite3") as typeof BetterSqlite3;
	}

	return databaseCache;
}

/**
 * Load sqlite-vec extension into a database.
 * Returns true if loaded successfully, false if unavailable (unsupported platform).
 */
export function loadSqliteVec(db: BetterSqlite3.Database): boolean {
	const extPath = getSqliteVecPath();
	if (!extPath) {
		// ponytail: platform package not found, skip vector search on unsupported arch
		return false;
	}

	try {
		if (isBun()) {
			// In Bun, use loadExtension directly with the path
			(db as any).loadExtension(extPath);
		} else {
			// In Node.js, use the sqlite-vec package's load function
			const nodeRequire = createRequire(import.meta.url);
			const sqliteVec = nodeRequire("sqlite-vec") as { load: (db: BetterSqlite3.Database) => void };
			sqliteVec.load(db);
		}
		return true;
	} catch {
		// ponytail: extension load failed (missing Visual C++, unsupported arch), degrade gracefully
		return false;
	}
}
