/**
 * Native module loader for veil-memory.
 *
 * Lazily installs better-sqlite3 and sqlite-vec into ~/.veil/deps/ on first use.
 * This avoids bundling platform-specific native modules in release archives.
 */

import type BetterSqlite3 from "better-sqlite3";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Use Module._load for loading external modules (bypasses Bun's bundled FS)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("module");
function loadExternal(modulePath: string): unknown {
	return Module._load(modulePath, null, false);
}

function getVeilDepsDir(): string {
	return join(homedir(), ".veil", "deps");
}

let depsInstalled = false;

function ensureNativeModules(): void {
	if (depsInstalled) return;

	const depsDir = getVeilDepsDir();
	const nodeModules = join(depsDir, "node_modules");
	const betterSqlite = join(nodeModules, "better-sqlite3");

	if (existsSync(betterSqlite)) {
		depsInstalled = true;
		return;
	}

	console.log("Installing native SQLite modules for memory features...");
	mkdirSync(depsDir, { recursive: true });

	// Write minimal package.json
	const pkg = { name: "veil-deps", private: true };
	writeFileSync(join(depsDir, "package.json"), JSON.stringify(pkg));

	const deps = "better-sqlite3 sqlite-vec";

	// Try bun first (faster), fall back to npm
	try {
		execSync(`bun add ${deps}`, { cwd: depsDir, stdio: "inherit" });
	} catch {
		try {
			execSync(`npm install ${deps}`, { cwd: depsDir, stdio: "inherit" });
		} catch (err) {
			throw new Error(
				`Failed to install native SQLite modules. Ensure npm or bun is available.\n${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	depsInstalled = true;
	console.log("Native SQLite modules installed successfully.");
}

let betterSqlite3Cache: typeof BetterSqlite3 | null = null;
let sqliteVecCache: { load: (db: BetterSqlite3.Database) => void } | null = null;

/**
 * Load better-sqlite3, installing it first if needed.
 */
export function loadBetterSqlite3(): typeof BetterSqlite3 {
	if (betterSqlite3Cache) return betterSqlite3Cache;

	ensureNativeModules();
	const modulePath = join(getVeilDepsDir(), "node_modules", "better-sqlite3");
	betterSqlite3Cache = loadExternal(modulePath) as typeof BetterSqlite3;
	return betterSqlite3Cache;
}

/**
 * Load sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: BetterSqlite3.Database): void {
	if (!sqliteVecCache) {
		ensureNativeModules();
		const modulePath = join(getVeilDepsDir(), "node_modules", "sqlite-vec");
		sqliteVecCache = loadExternal(modulePath) as { load: (db: BetterSqlite3.Database) => void };
	}
	sqliteVecCache.load(db);
}
