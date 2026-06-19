// packages/engrammic/src/prompts.ts

export const CONTEXT_MANAGEMENT_PROMPT = `## Working Memory

You have a managed context window. Items appear as stubs: \`[EPISODE:id:summary]\`

**The \`<veil-context>\` block** shown each turn is your current working set. Scan it before recalling more; what you need may already be there.

### Core loop

1. **Before diving in:** Glance at \`<veil-context>\`. If gaps exist, \`recall()\` with 1-3 semantic tags (what it's *about*: "user-constraints", "auth-flow", "error-handling").

2. **While working:** Reference stubs by ID when citing. \`hydrate()\` only when you need to reason over full content, not just acknowledge something exists.

3. **After completing a step:** \`demote()\` items you won't reference in the next few turns. Keep 5-7 items max unless actively synthesizing.

### What to pin
Pin sparingly — only user preferences, hard constraints, or decisions that would cause harm if forgotten. If unsure, don't pin.

### What to remember
\`remember()\` your interpretations: implications, connections, non-obvious conclusions. Raw outputs are auto-captured.

### Cross-session
Use \`history()\` when resuming work or referencing past sessions.

### Anticipated items
Items may auto-load based on the user's message. Treat them as suggestions — demote if irrelevant.

---
*Trust the system. Demote freely. Recall often. The goal is a focused context, not a complete one.*
`;

export interface CheckpointPromptOptions {
	turnCount: number;
	items: Array<{ stub: string; score: number; tokens: number; pinned: boolean }>;
	budget: { usedTokens: number; maxTokens: number };
}

export function buildCheckpointPrompt(options: CheckpointPromptOptions): string {
	const { turnCount, items, budget } = options;
	const budgetFree = budget.maxTokens === 0 ? 0 : Math.round((1 - budget.usedTokens / budget.maxTokens) * 100);

	const lines: string[] = [];
	lines.push(`<veil turn="${turnCount}" free="${budgetFree}%">`);

	// Compact item list: [id] score pin?
	const itemLines = items.map((item) => {
		const id = item.stub.split(":")[1];
		const pin = item.pinned ? " pin" : "";
		return `[${id}] ${item.score.toFixed(1)}${pin}`;
	});
	lines.push(itemLines.join(" | "));

	const lowScoring = items.filter((i) => i.score < 0.5 && !i.pinned);
	if (lowScoring.length > 0) {
		const ids = lowScoring.map((i) => i.stub.split(":")[1]).join(", ");
		lines.push(`Stale: ${ids} — demote if not needed`);
	}

	lines.push("</veil>");
	return lines.join("\n");
}

function formatTokens(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k tokens`;
	}
	return `${n} tokens`;
}
