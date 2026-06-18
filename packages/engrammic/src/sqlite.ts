/**
 * SQLite shim - re-exports better-sqlite3 via native-loader for Bun binary compatibility.
 *
 * Use this instead of importing better-sqlite3 directly to ensure native modules
 * are loaded from ~/.veil/deps/ in compiled Bun binaries.
 */

import { loadBetterSqlite3 } from "@veil/memory";
import type BetterSqlite3 from "better-sqlite3";

// Re-export the constructor as default (same as better-sqlite3)
const Database: typeof BetterSqlite3 = loadBetterSqlite3();
export default Database;
