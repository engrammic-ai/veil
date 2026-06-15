/**
 * PageRank-based file ranking for the structural worldview.
 *
 * Builds a directed graph of file dependencies from the symbol_graph table
 * and computes PageRank scores to identify structurally central files.
 * Results are persisted to the structural_rank table.
 */

import Database from "better-sqlite3";
import Graph from "graphology";
import pagerank from "graphology-pagerank";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const STRUCTURAL_RANK_SCHEMA = `
CREATE TABLE IF NOT EXISTS structural_rank (
  file TEXT PRIMARY KEY,
  pagerank REAL NOT NULL,
  task_bias REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RankRow {
	file: string;
	pagerank: number;
	task_bias: number;
	updated_at: number;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Reads the symbol_graph table and builds a directed graph where edges
 * go from the file containing a reference -> the file containing the
 * corresponding definition.
 *
 * Edge semantics: file A imports/references a symbol defined in file B
 * => edge A → B. PageRank will rank B higher because it is "pointed to"
 * by many other files.
 *
 * Only rows with kind='ref' and a non-null target_file are used; rows
 * without a resolved target_file are skipped (cross-file resolution is
 * done in a separate pass).
 */
export function buildFileGraph(db: Database.Database): Graph {
	const graph = new Graph({ type: "directed", multi: false });

	// Fetch all reference rows that have a resolved target_file
	const rows = db
		.prepare(
			`SELECT DISTINCT file, target_file
       FROM symbol_graph
       WHERE kind = 'ref' AND target_file IS NOT NULL AND target_file != file`,
		)
		.all() as Array<{ file: string; target_file: string }>;

	for (const row of rows) {
		if (!graph.hasNode(row.file)) {
			graph.addNode(row.file);
		}
		if (!graph.hasNode(row.target_file)) {
			graph.addNode(row.target_file);
		}
		// addEdge is idempotent due to multi:false — duplicate edges are silently ignored
		if (!graph.hasEdge(row.file, row.target_file)) {
			graph.addEdge(row.file, row.target_file);
		}
	}

	// Also ensure every file that appears as a definition source is present
	// as a node (even if nothing references it yet)
	const defFiles = db
		.prepare(
			`SELECT DISTINCT file FROM symbol_graph WHERE kind = 'def'`,
		)
		.all() as Array<{ file: string }>;

	for (const { file } of defFiles) {
		if (!graph.hasNode(file)) {
			graph.addNode(file);
		}
	}

	return graph;
}

// ---------------------------------------------------------------------------
// PageRank computation
// ---------------------------------------------------------------------------

/**
 * Computes PageRank scores for all nodes in the graph.
 * Returns a Map<file, score>.
 *
 * An empty graph returns an empty Map (no iterations needed).
 */
export function computePageRank(graph: Graph): Map<string, number> {
	if (graph.order === 0) {
		return new Map();
	}

	// pagerank() returns a plain object { [node]: score }
	const scores = pagerank(graph) as Record<string, number>;

	const result = new Map<string, number>();
	for (const [node, score] of Object.entries(scores)) {
		result.set(node, score);
	}
	return result;
}

// ---------------------------------------------------------------------------
// RankStore — persists scores to structural_rank
// ---------------------------------------------------------------------------

export class RankStore {
	private db: Database.Database;
	private stmtUpsert: Database.Statement;
	private stmtGet: Database.Statement;
	private stmtGetAll: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.initSchema();

		this.stmtUpsert = this.db.prepare(`
			INSERT INTO structural_rank (file, pagerank, task_bias, updated_at)
			VALUES (?, ?, 0, ?)
			ON CONFLICT(file) DO UPDATE SET
			  pagerank   = excluded.pagerank,
			  updated_at = excluded.updated_at
		`);

		this.stmtGet = this.db.prepare(
			"SELECT file, pagerank, task_bias, updated_at FROM structural_rank WHERE file = ?",
		);

		this.stmtGetAll = this.db.prepare(
			"SELECT file, pagerank, task_bias, updated_at FROM structural_rank ORDER BY pagerank DESC",
		);
	}

	/**
	 * Open a standalone RankStore backed by its own DB file.
	 * Convenient for tests that don't share the main cache DB.
	 */
	static open(dbPath: string): RankStore {
		const db = new Database(dbPath);
		db.pragma("journal_mode = WAL");
		return new RankStore(db);
	}

	/**
	 * Persist a batch of pagerank scores, replacing any existing values.
	 * task_bias is preserved for existing rows (only pagerank + updated_at change).
	 */
	saveRanks(scores: Map<string, number>): void {
		const now = Date.now();
		const upsert = this.stmtUpsert;

		const run = this.db.transaction(() => {
			for (const [file, score] of scores) {
				upsert.run(file, score, now);
			}
		});
		run();
	}

	getRank(file: string): RankRow | null {
		const row = this.stmtGet.get(file) as RankRow | undefined;
		return row ?? null;
	}

	getAllRanks(): RankRow[] {
		return this.stmtGetAll.all() as RankRow[];
	}

	close(): void {
		this.db.close();
	}

	// -------------------------------------------------------------------------
	// Private
	// -------------------------------------------------------------------------

	private initSchema(): void {
		this.db.exec(STRUCTURAL_RANK_SCHEMA);
	}
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

/**
 * Full pipeline: build graph → compute PageRank → store results.
 *
 * Idempotent: safe to call repeatedly as the symbol_graph is updated.
 * Returns the number of files ranked.
 */
export function updateRanks(db: Database.Database): number {
	const store = new RankStore(db);
	const graph = buildFileGraph(db);
	const scores = computePageRank(graph);
	store.saveRanks(scores);
	return scores.size;
}
