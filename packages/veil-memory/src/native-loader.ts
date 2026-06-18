/**
 * Native module loader for Bun binaries.
 *
 * When running as a compiled Bun binary, native .node modules can't be
 * bundled directly. Instead, we ship them alongside the binary and load
 * them from a known relative path.
 */

import { createRequire } from "module";
import { dirname, join } from "path";
import { existsSync } from "fs";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);

// Detect if running as Bun compiled binary
function isBunBinary(): boolean {
  if (process.execPath.includes("/$bunfs/")) return true;
  // @ts-expect-error - Bun global only exists in Bun runtime
  if (typeof globalThis.Bun !== "undefined" && globalThis.Bun.main?.includes("/$bunfs/")) return true;
  return false;
}

/**
 * Get the directory where native modules are bundled.
 * For Bun binaries: <binary_dir>/native/sqlite/
 * For dev/Node: use regular node_modules
 */
function getNativeDir(): string | null {
  if (!isBunBinary()) return null;

  // In Bun binary, process.execPath points to the actual binary location
  const binaryDir = dirname(process.execPath);
  const nativeDir = join(binaryDir, "native", "sqlite");

  if (existsSync(nativeDir)) {
    return nativeDir;
  }
  return null;
}

/**
 * Load better-sqlite3 from bundled native modules or node_modules.
 */
export function loadBetterSqlite3(): typeof BetterSqlite3 {
  const nativeDir = getNativeDir();

  if (nativeDir) {
    // Running as Bun binary - load from bundled natives
    const nodePath = join(nativeDir, "better_sqlite3.node");
    if (existsSync(nodePath)) {
      // Set env var that better-sqlite3 checks for custom binding path
      process.env.BETTER_SQLITE3_BINDING = nodePath;
    }
  }

  // Load better-sqlite3 (will use env var if set, else normal resolution)
  return require("better-sqlite3");
}

/**
 * Load sqlite-vec extension into a database.
 */
export function loadSqliteVec(db: BetterSqlite3.Database): void {
  const nativeDir = getNativeDir();

  if (nativeDir) {
    // Try to find the vec extension in bundled natives
    const extensions = ["vec0.so", "vec0.dylib", "vec0.dll"];
    for (const ext of extensions) {
      const extPath = join(nativeDir, ext);
      if (existsSync(extPath)) {
        // loadExtension expects path without extension
        db.loadExtension(extPath.replace(/\.(so|dylib|dll)$/, ""));
        return;
      }
    }
  }

  // Fall back to sqlite-vec's built-in loader
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(db);
}
