import type { ArchivedTurn, ConversationArchive } from "../conversation-archive.ts";

export interface HistoryCommandOptions {
	archive: ConversationArchive;
	sessionId?: string;
	query?: string;
	type?: string;
	limit?: number;
}

export interface HistoryResult {
	turnId: string;
	turnNumber: number;
	role: string;
	type?: string;
	preview: string;
	decisionSummary?: string;
	evicted: boolean;
}

export async function executeHistoryCommand(options: HistoryCommandOptions): Promise<HistoryResult[]> {
	const { archive, sessionId, query, type, limit = 20 } = options;

	let turns: ArchivedTurn[];

	if (query) {
		turns = await archive.searchContent(query, limit);
	} else if (type) {
		turns = await archive.getByType(type, limit);
	} else if (sessionId) {
		// getTurnRange with a very large range to get all turns for session
		turns = await archive.getTurnRange(sessionId, 0, Number.MAX_SAFE_INTEGER);
		turns = turns.slice(0, limit);
	} else {
		// No filter — return recent turns via content search with empty-string workaround
		turns = await archive.searchContent("", limit);
	}

	if (sessionId && query) {
		turns = turns.filter((t) => t.sessionId === sessionId);
	} else if (sessionId && type) {
		turns = turns.filter((t) => t.sessionId === sessionId);
	}

	return turns.map((turn) => ({
		turnId: turn.turnId,
		turnNumber: turn.turnNumber,
		role: turn.role,
		type: turn.metaType,
		preview: turn.content.slice(0, 100),
		decisionSummary: turn.decisionSummary,
		evicted: turn.evictedAt !== undefined,
	}));
}

export function formatHistoryResults(results: HistoryResult[]): string {
	if (results.length === 0) {
		return "  (no results)";
	}

	const lines: string[] = [];
	for (const r of results) {
		const evictedMarker = r.evicted ? " [evicted]" : "";
		const typeMarker = r.type ? ` [${r.type}]` : "";
		lines.push(`  #${r.turnNumber} ${r.role}${typeMarker}${evictedMarker}`);
		lines.push(`    ${r.preview}`);
		if (r.decisionSummary) {
			lines.push(`    Decision: ${r.decisionSummary}`);
		}
	}
	return lines.join("\n");
}
