import type { ArchivedTurn } from "./conversation-archive.ts";

export interface StubOptions {
	turns: ArchivedTurn[];
	capturedIds?: Map<string, string>; // turnId -> veil item id
}

// Patterns to extract key actions from turn content
const READ_PATTERN = /(?:read|reading|opened?|viewed?)\s+([\w./-]+\.[a-z]+)/gi;
const WRITE_PATTERN = /(?:wrote?|writing|created?|modified?|updated?)\s+([\w./-]+\.[a-z]+)/gi;
const DECISION_PATTERN = /(?:decided?|choosing?|chose|will use|using)\s*:?\s*([^.\n]{5,60})/gi;
const COMPLETED_PATTERN = /(?:completed?|finished?|done with)\s*:?\s*([^.\n]{5,60})/gi;

function extractMatches(content: string, pattern: RegExp): string[] {
	const matches: string[] = [];
	const re = new RegExp(pattern.source, pattern.flags);
	let match = re.exec(content);
	while (match !== null) {
		if (match[1]) matches.push(match[1].trim());
		match = re.exec(content);
	}
	return matches;
}

export function summarizeAction(turn: ArchivedTurn): string {
	const content = turn.content;

	// Use decisionSummary if available
	if (turn.decisionSummary) {
		return `Decided: ${turn.decisionSummary}`;
	}

	// Use metaType to guide extraction
	if (turn.metaType === "decision" || turn.metaType === "intent_declaration") {
		const decisions = extractMatches(content, DECISION_PATTERN);
		if (decisions.length > 0) {
			return `Decided: ${decisions[0]}`;
		}
	}

	// Try to extract file reads/writes
	const reads = extractMatches(content, READ_PATTERN);
	const writes = extractMatches(content, WRITE_PATTERN);

	if (writes.length > 0) {
		return `Modified: ${writes.slice(0, 3).join(", ")}`;
	}

	if (reads.length > 0) {
		return `Read: ${reads.slice(0, 3).join(", ")}`;
	}

	// Try completed tasks
	const completed = extractMatches(content, COMPLETED_PATTERN);
	if (completed.length > 0) {
		return `Completed: ${completed[0]}`;
	}

	// Fall back to first meaningful line of content
	const firstLine = content
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 10);
	if (firstLine) {
		return firstLine.slice(0, 80) + (firstLine.length > 80 ? "..." : "");
	}

	return `Turn ${turn.turnNumber} (${turn.metaType ?? turn.role})`;
}

export function groupConsecutiveTurns(turnNumbers: number[]): Array<[number, number]> {
	if (turnNumbers.length === 0) return [];

	const sorted = [...turnNumbers].sort((a, b) => a - b);
	const groups: Array<[number, number]> = [];
	let start = sorted[0]!;
	let prev = sorted[0]!;

	for (let i = 1; i < sorted.length; i++) {
		const cur = sorted[i]!;
		if (cur === prev + 1) {
			prev = cur;
		} else {
			groups.push([start, prev]);
			start = cur;
			prev = cur;
		}
	}
	groups.push([start, prev]);

	return groups;
}

export function generateStub(options: StubOptions): string {
	const { turns, capturedIds } = options;
	if (turns.length === 0) return "";

	const turnNumbers = turns.map((t) => t.turnNumber);
	const minTurn = Math.min(...turnNumbers);
	const maxTurn = Math.max(...turnNumbers);

	const rangeLabel = minTurn === maxTurn ? `Turn ${minTurn} summarized` : `Turns ${minTurn}-${maxTurn} summarized`;

	const lines: string[] = [`[${rangeLabel}]`];

	// Build action lines, collecting captured ids per action
	for (const turn of turns) {
		const action = summarizeAction(turn);
		const capturedId = capturedIds?.get(turn.turnId);
		if (capturedId) {
			lines.push(`- ${action} (captured: ${capturedId})`);
		} else {
			lines.push(`- ${action}`);
		}
	}

	// Hint for retrieval
	const keywords = turns
		.flatMap((t) => (t.metaType ? [t.metaType] : []))
		.filter((v, i, arr) => arr.indexOf(v) === i)
		.slice(0, 2);

	const hint = keywords.length > 0 ? keywords.join(" ") : "this session";
	lines.push(`Use veil_history("${hint}") for details.`);

	return lines.join("\n");
}
