import type { TurnMeta } from "./types.ts";

type TurnType = TurnMeta["type"];

const HEURISTIC_PATTERNS: Record<TurnType, RegExp[]> = {
	decision: [/I('ll| will) use/i, /let's go with/i, /the approach (is|will be)/i, /decision:/i],
	correction: [/^(no|actually|wait)/i, /that's (not|wrong)/i, /instead,/i],
	intent: [/I want to/i, /the goal is/i, /we need to/i],
	exploration: [/what if/i, /we could/i, /another option/i],
	action: [/I'll (read|write|run|check)/i, /let me (look|search|find)/i],
	status: [/done with/i, /completed/i, /finished/i],
};

const TURN_META_RE = /<turn-meta>\n([\s\S]*?)\n<\/turn-meta>/;

export function parseTurnMeta(response: string): TurnMeta | null {
	const match = TURN_META_RE.exec(response);
	if (!match) return null;

	const block = match[1];
	const fields: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key && value) fields[key] = value;
	}

	const VALID_TYPES = new Set<TurnType>(["decision", "exploration", "action", "correction", "status", "intent"]);
	const rawType = fields.type;
	if (!rawType || !VALID_TYPES.has(rawType as TurnType)) return null;

	const meta: TurnMeta = { type: rawType as TurnType };
	if (fields.intent) meta.intentId = fields.intent;
	if (fields.decision) meta.decisionSummary = fields.decision;

	return meta;
}

export function heuristicClassify(content: string, role: "user" | "assistant"): TurnMeta {
	for (const [turnType, patterns] of Object.entries(HEURISTIC_PATTERNS) as [TurnType, RegExp[]][]) {
		if (patterns.some((p) => p.test(content))) {
			return { type: turnType };
		}
	}
	// Role-based default: user messages without a strong signal are usually intent
	return { type: role === "user" ? "intent" : "action" };
}

export function classifyTurn(response: string, role: "user" | "assistant"): TurnMeta {
	const parsed = parseTurnMeta(response);
	if (parsed) return parsed;
	return heuristicClassify(response, role);
}

export function stripTurnMeta(response: string): string {
	return response.replace(/\n?<turn-meta>\n[\s\S]*?\n<\/turn-meta>/, "").trimEnd();
}
