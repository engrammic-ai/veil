import { PROTECTED_WINDOW } from "./reference-detector.ts";

export { PROTECTED_WINDOW };

// Maps turn type to eviction weight (0 = never evict, 1 = safe to evict)
// "intent" is an alias for "intent_declaration" in TurnMeta
export const TYPE_WEIGHTS: Record<string, number> = {
	intent_declaration: 0.0,
	intent: 0.0, // TurnMeta uses "intent" for intent_declaration
	decision: 0.1,
	correction: 0.0,
	exploration: 0.8,
	action: 0.6,
	status: 0.7,
};

export interface ScoredTurn {
	turnId: string;
	turnNumber: number;
	type: string;
	evictionScore: number; // 0 = never evict, 1 = safe to evict
}

export function isNeverEvict(type: string): boolean {
	const weight = TYPE_WEIGHTS[type];
	return weight === undefined || weight === 0.0;
}

export function calculateEvictionScore(
	turn: { turnNumber: number; type: string },
	currentTurn: number,
	referencePenalty: number, // 0-1 from reference-detector
): number {
	const age = currentTurn - turn.turnNumber;

	// Protected window — always 0
	if (age <= PROTECTED_WINDOW) return 0;

	// Never-evict types — always 0
	if (isNeverEvict(turn.type)) return 0;

	const typeWeight = TYPE_WEIGHTS[turn.type] ?? 0.8;
	const ageFactor = Math.min(1.0, (age - PROTECTED_WINDOW) / 20);

	return ageFactor * typeWeight * referencePenalty;
}

export function rankForEviction(
	turns: Array<{ turnId: string; turnNumber: number; type: string; referencePenalty: number }>,
	currentTurn: number,
): ScoredTurn[] {
	return turns
		.map((t) => ({
			turnId: t.turnId,
			turnNumber: t.turnNumber,
			type: t.type,
			evictionScore: calculateEvictionScore(t, currentTurn, t.referencePenalty),
		}))
		.sort((a, b) => b.evictionScore - a.evictionScore);
}

export function selectForEviction(
	rankedTurns: ScoredTurn[],
	tokenCounts: Map<string, number>,
	targetTokens: number,
): string[] {
	const selected: string[] = [];
	let freed = 0;

	for (const turn of rankedTurns) {
		if (freed >= targetTokens) break;
		// Skip turns with score 0 (never evict)
		if (turn.evictionScore === 0) continue;

		const tokens = tokenCounts.get(turn.turnId) ?? 0;
		selected.push(turn.turnId);
		freed += tokens;
	}

	return selected;
}
