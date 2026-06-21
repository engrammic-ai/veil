export const PROTECTED_WINDOW = 12;
export const SIMILARITY_THRESHOLD = 0.7;

export interface TurnWithEmbedding {
	turnId: string;
	turnNumber: number;
	embedding: Float32Array;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) throw new Error("Embedding dimension mismatch");
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dot / denom;
}

export function computeReferencePenalty(turn: TurnWithEmbedding, recentTurns: TurnWithEmbedding[]): number {
	if (recentTurns.length === 0) return 1.0;
	const similarities = recentTurns.map((r) => cosineSimilarity(turn.embedding, r.embedding));
	const maxSim = Math.max(...similarities);
	if (maxSim > SIMILARITY_THRESHOLD) {
		return 1 - maxSim;
	}
	return 1.0;
}

export function isProtected(turnNumber: number, currentTurn: number): boolean {
	return currentTurn - turnNumber <= PROTECTED_WINDOW;
}
