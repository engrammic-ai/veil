// packages/engrammic/src/prompts.ts

export const CONTEXT_MANAGEMENT_PROMPT = `## Context Management

Your context window is finite and managed. Items appear as stubs like [EPISODE:abc123:summary].
You must actively curate what stays loaded.

BEFORE starting a subtask: call recall(tags) with 2-3 relevant tags. Don't assume you remember — check first.

AFTER completing a subtask: demote items not relevant to the next step. If you wouldn't cite it in your next 3 responses, demote it.

ALWAYS pin immediately: user preferences, constraints, design decisions. These must never be lost mid-task.

USE remember() for: your interpretations, implications, non-obvious discoveries. Don't remember raw outputs — auto-capture handles those.

Demoting is safe. Recall is fast. Trust the system to find things again.

Anti-patterns to avoid:
- Don't pin speculatively
- Don't keep more than 5-7 items promoted at once
- Don't call forget() during active work — only at explicit cleanup
`;

export interface CheckpointPromptOptions {
	turnCount: number;
	items: Array<{ stub: string; score: number; tokens: number; pinned: boolean }>;
	budget: { usedTokens: number; maxTokens: number };
}

export function buildCheckpointPrompt(options: CheckpointPromptOptions): string {
	const { turnCount, items, budget } = options;
	const totalTokens = items.reduce((sum, i) => sum + i.tokens, 0);
	const budgetFree = Math.round((1 - budget.usedTokens / budget.maxTokens) * 100);

	const lines: string[] = [];
	lines.push(`<context-checkpoint turn="${turnCount}">`);
	lines.push(`HOT (${items.length} items, ${formatTokens(totalTokens)}, budget ${budgetFree}% free):`);

	for (const item of items) {
		const pinLabel = item.pinned ? ", pinned" : "";
		lines.push(`  ${item.stub} — score: ${item.score.toFixed(2)}, ${formatTokens(item.tokens)}${pinLabel}`);
	}

	const lowScoring = items.filter((i) => i.score < 0.5 && !i.pinned);
	if (lowScoring.length > 0) {
		lines.push("");
		lines.push(`Review: Does each item affect your next action? If not, demote it.`);
		lines.push(`Low-scoring candidates: ${lowScoring.map((i) => i.stub.split(":")[1]).join(", ")}`);
	}

	lines.push("</context-checkpoint>");
	return lines.join("\n");
}

function formatTokens(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k tokens`;
	}
	return `${n} tokens`;
}
