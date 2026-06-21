import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "module";

function isBun(): boolean {
	return typeof (globalThis as any).Bun !== "undefined";
}

function loadDatabase(): typeof BetterSqlite3 {
	if (isBun()) {
		const { Database } = require("bun:sqlite") as { Database: any };
		const Wrapped = function (this: any, filename: string, options?: any) {
			const db = new Database(filename, options);
			db.pragma = function (pragma: string) {
				return this.exec(`PRAGMA ${pragma}`);
			};
			return db;
		} as unknown as typeof BetterSqlite3;
		Object.setPrototypeOf(Wrapped, Database);
		Wrapped.prototype = Database.prototype;
		return Wrapped;
	}
	const nodeRequire = createRequire(import.meta.url);
	return nodeRequire("better-sqlite3") as typeof BetterSqlite3;
}

export interface ArchivedTurn {
	turnId: string;
	sessionId: string;
	turnNumber: number;
	role: "user" | "assistant" | "tool";
	content: string;
	metaType?: string;
	intentId?: string;
	decisionSummary?: string;
	evictedAt?: number;
	stubText?: string;
	embedding?: Float32Array;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS conversation_archive (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_type TEXT,
  intent_id TEXT,
  decision_summary TEXT,
  evicted_at INTEGER,
  stub_text TEXT,
  embedding BLOB,
  UNIQUE(session_id, turn_number)
)`;

const CREATE_INDEXES = [
	"CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_archive(session_id)",
	"CREATE INDEX IF NOT EXISTS idx_conv_type ON conversation_archive(meta_type)",
	"CREATE INDEX IF NOT EXISTS idx_conv_intent ON conversation_archive(intent_id)",
];

function rowToTurn(row: any): ArchivedTurn {
	return {
		turnId: row.turn_id,
		sessionId: row.session_id,
		turnNumber: row.turn_number,
		role: row.role,
		content: row.content,
		metaType: row.meta_type ?? undefined,
		intentId: row.intent_id ?? undefined,
		decisionSummary: row.decision_summary ?? undefined,
		evictedAt: row.evicted_at ?? undefined,
		stubText: row.stub_text ?? undefined,
		embedding: row.embedding ? new Float32Array(row.embedding.buffer ?? row.embedding) : undefined,
	};
}

export class ConversationArchive {
	private db: BetterSqlite3.Database | null = null;
	private dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	async init(): Promise<void> {
		const Database = loadDatabase();
		this.db = new Database(this.dbPath) as BetterSqlite3.Database;
		this.db.pragma("journal_mode = WAL");
		this.db.exec(CREATE_TABLE);
		for (const idx of CREATE_INDEXES) {
			this.db.exec(idx);
		}
	}

	private get conn(): BetterSqlite3.Database {
		if (!this.db) throw new Error("ConversationArchive not initialized — call init() first");
		return this.db;
	}

	async archiveTurn(turn: ArchivedTurn): Promise<void> {
		const embeddingBuffer = turn.embedding ? Buffer.from(turn.embedding.buffer) : null;
		this.conn
			.prepare(
				`INSERT OR REPLACE INTO conversation_archive
        (turn_id, session_id, turn_number, role, content, meta_type, intent_id,
         decision_summary, evicted_at, stub_text, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				turn.turnId,
				turn.sessionId,
				turn.turnNumber,
				turn.role,
				turn.content,
				turn.metaType ?? null,
				turn.intentId ?? null,
				turn.decisionSummary ?? null,
				turn.evictedAt ?? null,
				turn.stubText ?? null,
				embeddingBuffer,
			);
	}

	async getTurn(turnId: string): Promise<ArchivedTurn | null> {
		const row = this.conn.prepare("SELECT * FROM conversation_archive WHERE turn_id = ?").get(turnId) as any;
		return row ? rowToTurn(row) : null;
	}

	async getTurnRange(sessionId: string, start: number, end: number): Promise<ArchivedTurn[]> {
		const rows = this.conn
			.prepare(
				"SELECT * FROM conversation_archive WHERE session_id = ? AND turn_number BETWEEN ? AND ? ORDER BY turn_number",
			)
			.all(sessionId, start, end) as any[];
		return rows.map(rowToTurn);
	}

	async markEvicted(turnId: string, stubText: string): Promise<void> {
		this.conn
			.prepare("UPDATE conversation_archive SET evicted_at = ?, stub_text = ? WHERE turn_id = ?")
			.run(Date.now(), stubText, turnId);
	}

	async searchByIntent(intentId: string): Promise<ArchivedTurn[]> {
		const rows = this.conn
			.prepare("SELECT * FROM conversation_archive WHERE intent_id = ? ORDER BY turn_number")
			.all(intentId) as any[];
		return rows.map(rowToTurn);
	}

	async pruneOldTurns(olderThanMs: number, excludeTypes: string[]): Promise<number> {
		const cutoff = Date.now() - olderThanMs;
		const placeholders = excludeTypes.length > 0 ? excludeTypes.map(() => "?").join(", ") : null;
		const query = placeholders
			? `DELETE FROM conversation_archive WHERE evicted_at IS NOT NULL AND evicted_at < ? AND (meta_type IS NULL OR meta_type NOT IN (${placeholders}))`
			: `DELETE FROM conversation_archive WHERE evicted_at IS NOT NULL AND evicted_at < ?`;
		const result = this.conn.prepare(query).run(cutoff, ...excludeTypes) as BetterSqlite3.RunResult;
		return result.changes;
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}
