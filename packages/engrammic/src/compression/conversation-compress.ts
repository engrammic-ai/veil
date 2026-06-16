/**
 * Conversation compression — head-summary + tail-preserve.
 *
 * Deterministic strategy:
 * 1. Preserve first N turns (context setup)
 * 2. Preserve last M turns (recent context)
 * 3. Middle section: extract turn boundaries + key decisions/actions
 */

export interface ConversationCompressOptions {
	headTurns?: number;
	tailTurns?: number;
	maxMiddleSummaryLines?: number;
}

const DEFAULT_OPTIONS: Required<ConversationCompressOptions> = {
	headTurns: 2,
	tailTurns: 3,
	maxMiddleSummaryLines: 10,
};

const TURN_MARKERS = [
	/^(Human|User|Assistant|AI|System|Claude|GPT|Bot):\s*/i,
	/^>\s+\*\*(Human|User|Assistant|AI)\*\*/i,
	/^\[[\d:]+\]\s*(Human|User|Assistant|AI):/i,
	/^#{1,3}\s*(Human|User|Assistant|AI|Turn)/i,
];

const ACTION_MARKERS = [
	/\b(decided|concluded|agreed|confirmed|approved|rejected|chose|selected)\b/i,
	/\b(created|updated|deleted|modified|added|removed|fixed|changed)\b/i,
	/\b(error|failed|succeeded|completed|finished|done)\b/i,
	/\b(TODO|FIXME|NOTE|IMPORTANT|WARNING)\b/,
	/```/,
];

/**
 * Compress conversation by preserving head + tail and summarizing middle.
 */
export function compressConversation(text: string, options?: ConversationCompressOptions): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const turns = splitIntoTurns(text);

	if (turns.length <= opts.headTurns + opts.tailTurns) {
		return text;
	}

	const head = turns.slice(0, opts.headTurns);
	const tail = opts.tailTurns > 0 ? turns.slice(-opts.tailTurns) : [];
	const middle = opts.tailTurns > 0 ? turns.slice(opts.headTurns, -opts.tailTurns) : turns.slice(opts.headTurns);

	const middleSummary = summarizeMiddle(middle, opts.maxMiddleSummaryLines);

	const result: string[] = [];

	for (const turn of head) {
		result.push(turn.content);
	}

	if (middleSummary.length > 0) {
		result.push("");
		result.push(`[... ${middle.length} turns summarized ...]`);
		for (const line of middleSummary) {
			result.push(`  ${line}`);
		}
		result.push("");
	}

	for (const turn of tail) {
		result.push(turn.content);
	}

	return result.join("\n");
}

interface Turn {
	speaker: string;
	content: string;
	lineStart: number;
}

function splitIntoTurns(text: string): Turn[] {
	const lines = text.split("\n");
	const turns: Turn[] = [];
	let currentTurn: Turn | null = null;
	let currentLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const speaker = detectSpeaker(line);

		if (speaker && currentTurn) {
			currentTurn.content = currentLines.join("\n");
			turns.push(currentTurn);
			currentTurn = { speaker, content: "", lineStart: i };
			currentLines = [line];
		} else if (speaker && !currentTurn) {
			currentTurn = { speaker, content: "", lineStart: i };
			currentLines = [line];
		} else {
			currentLines.push(line);
		}
	}

	if (currentTurn) {
		currentTurn.content = currentLines.join("\n");
		turns.push(currentTurn);
	} else if (currentLines.length > 0) {
		turns.push({ speaker: "unknown", content: currentLines.join("\n"), lineStart: 0 });
	}

	return turns;
}

function detectSpeaker(line: string): string | null {
	for (const marker of TURN_MARKERS) {
		const match = line.match(marker);
		if (match) {
			return match[1]?.toLowerCase() ?? "speaker";
		}
	}
	return null;
}

function summarizeMiddle(turns: Turn[], maxLines: number): string[] {
	const summary: string[] = [];

	for (const turn of turns) {
		if (summary.length >= maxLines) break;

		const actions = extractActions(turn.content);
		if (actions.length > 0) {
			summary.push(`${turn.speaker}: ${actions[0]}`);
		}
	}

	if (summary.length === 0 && turns.length > 0) {
		summary.push(`${turns.length} turns with no key actions detected`);
	}

	return summary;
}

function extractActions(content: string): string[] {
	const actions: string[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		for (const marker of ACTION_MARKERS) {
			if (marker.test(line)) {
				const trimmed = line.trim().slice(0, 80);
				if (trimmed && !actions.includes(trimmed)) {
					actions.push(trimmed);
				}
				break;
			}
		}
	}

	return actions.slice(0, 3);
}
