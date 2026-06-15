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
import { SymbolStore } from "./symbol-store.ts";

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
// Task bias computation
// ---------------------------------------------------------------------------

/**
 * Computes a task-personalized bias for each file in the graph based on which
 * files are currently in the hot context (being actively worked on).
 *
 * Files directly connected to hot files get a bias boost of 1.0, files two
 * hops away get 0.5, three hops get 0.25, etc. (geometric decay by hop count).
 * Hot files themselves receive a bias of 1.0.
 *
 * Returns a Map<file, bias> where bias is in the range [0, 1].
 * Files not reachable from any hot file are not included in the result.
 */
export function computeTaskBias(graph: Graph, hotFiles: string[], maxHops = 3): Map<string, number> {
	const bias = new Map<string, number>();

	if (hotFiles.length === 0 || graph.order === 0) {
		return bias;
	}

	// BFS from each hot file, propagating decayed bias to neighbors.
	// We use an undirected traversal (both in-edges and out-edges) so that
	// files which import a hot file are also boosted — the bias flows both ways.
	for (const hotFile of hotFiles) {
		if (!graph.hasNode(hotFile)) {
			continue;
		}

		// BFS queue: [node, hop distance from hotFile]
		const queue: Array<[string, number]> = [[hotFile, 0]];
		const visited = new Set<string>();

		while (queue.length > 0) {
			const [node, hop] = queue.shift()!;

			if (visited.has(node)) {
				continue;
			}
			visited.add(node);

			if (hop > maxHops) {
				continue;
			}

			// Decay: 1.0 at hop 0, 0.5 at hop 1, 0.25 at hop 2, …
			const contribution = 1.0 / (2 ** hop);

			// Keep the maximum contribution seen so far for this node
			const existing = bias.get(node) ?? 0;
			bias.set(node, Math.max(existing, contribution));

			if (hop < maxHops) {
				// Visit all neighbors (undirected: out-edges and in-edges)
				graph.neighbors(node).forEach((neighbor: string) => {
					if (!visited.has(neighbor)) {
						queue.push([neighbor, hop + 1]);
					}
				});
			}
		}
	}

	return bias;
}

/**
 * Computes task bias from hot files and writes the results to the
 * structural_rank table.  Files not reached from any hot file have their
 * task_bias reset to 0 so stale bias doesn't accumulate across tasks.
 */
export function updateTaskBias(db: Database.Database, hotFiles: string[]): void {
	const graph = buildFileGraph(db);
	const biasMap = computeTaskBias(graph, hotFiles);

	const resetAll = db.prepare("UPDATE structural_rank SET task_bias = 0");
	const upsertBias = db.prepare(`
		INSERT INTO structural_rank (file, pagerank, task_bias, updated_at)
		VALUES (?, 0, ?, ?)
		ON CONFLICT(file) DO UPDATE SET
		  task_bias  = excluded.task_bias,
		  updated_at = excluded.updated_at
	`);

	const run = db.transaction(() => {
		resetAll.run();
		const now = Date.now();
		for (const [file, biasValue] of biasMap) {
			upsertBias.run(file, biasValue, now);
		}
	});
	run();
}

// ---------------------------------------------------------------------------
// RankStore — persists scores to structural_rank
// ---------------------------------------------------------------------------

export class RankStore {
	private db: Database.Database;
	private stmtUpsert: Database.Statement;
	private stmtGet: Database.Statement;
	private stmtGetAll: Database.Statement;
	private stmtUpdateBias: Database.Statement;

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

		this.stmtUpdateBias = this.db.prepare(
			"UPDATE structural_rank SET task_bias = ?, updated_at = ? WHERE file = ?",
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
	 * Update the task_bias for a single file.
	 * No-op if the file does not yet have a row in structural_rank.
	 */
	updateBias(file: string, bias: number): void {
		this.stmtUpdateBias.run(bias, Date.now(), file);
	}

	/**
	 * Returns the effective rank for a file, combining its PageRank score with
	 * the task bias: effectiveRank = pagerank * (1 + task_bias).
	 *
	 * Returns null when the file is not present in the table.
	 */
	getEffectiveRank(file: string): number | null {
		const row = this.getRank(file);
		if (row === null) {
			return null;
		}
		return row.pagerank * (1 + row.task_bias);
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
 * Full pipeline: resolve refs → build graph → compute PageRank → store results.
 *
 * Idempotent: safe to call repeatedly as the symbol_graph is updated.
 * Returns the number of files ranked.
 */
export function updateRanks(db: Database.Database): number {
	// Resolve cross-file references before building the graph
	const symbolStore = new SymbolStore(db);
	symbolStore.resolveReferences();

	const store = new RankStore(db);
	const graph = buildFileGraph(db);
	const scores = computePageRank(graph);
	store.saveRanks(scores);
	return scores.size;
}
