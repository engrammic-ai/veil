/**
 * SQLite-backed store for the symbol_graph table.
 *
 * Provides per-file upsert and lookup for the structural worldview.
 * Designed to be used alongside ContextCache (same DB file) or standalone.
 */

import Database from "better-sqlite3";
import type { ExtractedSymbol } from "./symbols.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SymbolRow {
	file: string;
	symbol: string;
	kind: "def" | "ref";
	target_file: string | null;
	target_symbol: string | null;
	line: number;
}

// ---------------------------------------------------------------------------
// Schema (also added to cache.ts init)
// ---------------------------------------------------------------------------

export const SYMBOL_GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS symbol_graph (
	file TEXT NOT NULL,
	symbol TEXT NOT NULL,
	kind TEXT NOT NULL,
	target_file TEXT,
	target_symbol TEXT,
	line INTEGER,
	PRIMARY KEY (file, symbol, kind, line)
);
CREATE INDEX IF NOT EXISTS idx_symbol_graph_file ON symbol_graph(file);
CREATE INDEX IF NOT EXISTS idx_symbol_graph_symbol ON symbol_graph(symbol);
`;

// ---------------------------------------------------------------------------
// SymbolStore
// ---------------------------------------------------------------------------

export class SymbolStore {
	private db: Database.Database;

	private stmtInsert: Database.Statement;
	private stmtDeleteFile: Database.Statement;
	private stmtGetByFile: Database.Statement;
	private stmtGetRefsTo: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.initSchema();

		this.stmtInsert = this.db.prepare(`
			INSERT OR REPLACE INTO symbol_graph
			(file, symbol, kind, target_file, target_symbol, line)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmtDeleteFile = this.db.prepare(`
			DELETE FROM symbol_graph WHERE file = ?
		`);

		this.stmtGetByFile = this.db.prepare(`
			SELECT file, symbol, kind, target_file, target_symbol, line
			FROM symbol_graph
			WHERE file = ?
			ORDER BY line ASC
		`);

		this.stmtGetRefsTo = this.db.prepare(`
			SELECT file, line
			FROM symbol_graph
			WHERE symbol = ? AND kind = 'ref'
			ORDER BY file, line
		`);
	}

	/**
	 * Open a standalone SymbolStore backed by its own DB file.
	 * Convenient for tests and tools that don't share the main cache DB.
	 */
	static open(dbPath: string): SymbolStore {
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		return new SymbolStore(db);
	}

	/**
	 * Replace all symbols for a given file with the provided extracted symbols.
	 * Runs as a transaction: delete-then-insert so partial failures roll back.
	 *
	 * - `symbols` should be the output of `SymbolExtractor.extractSymbols()`.
	 * - `target_file` and `target_symbol` are not populated here (reserved for
	 *   a future cross-file resolution pass).
	 */
	upsertSymbols(file: string, symbols: ExtractedSymbol[]): void {
		const insert = this.stmtInsert;
		const del = this.stmtDeleteFile;

		const run = this.db.transaction(() => {
			del.run(file);
			for (const sym of symbols) {
				insert.run(file, sym.symbol, sym.kind, null, null, sym.line);
			}
		});
		run();
	}

	/**
	 * Return all symbol rows for a given file.
	 */
	getSymbolsForFile(file: string): SymbolRow[] {
		return this.stmtGetByFile.all(file) as SymbolRow[];
	}

	/**
	 * Return all files (and lines) that contain a reference to the given symbol.
	 * Used by PageRank / link-analysis to build the symbol reference graph.
	 */
	getReferencesTo(symbol: string): Array<{ file: string; line: number }> {
		const rows = this.stmtGetRefsTo.all(symbol) as Array<{ file: string; line: number }>;
		return rows;
	}

	close(): void {
		this.db.close();
	}

	// -------------------------------------------------------------------------
	// Private
	// -------------------------------------------------------------------------

	private initSchema(): void {
		this.db.exec(SYMBOL_GRAPH_SCHEMA);
	}
}
