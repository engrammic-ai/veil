// packages/engrammic/src/prompts.ts

export const CONTEXT_MANAGEMENT_PROMPT = `## Working Memory

You have a managed context window. Items appear as stubs: \`[EPISODE:id:summary]\`

**The \`<veil-context>\` block** shown each turn is your current working set. Scan it before recalling more; what you need may already be there.

### Reading tool results
Tool results are wrapped in \`<veil-{tool} count="N">\` tags:
- \`count > 0\` = memories found, listed inside the tag
- \`count = 0\` = nothing found for that query; try different tags
- Each item shows: \`[TYPE:id:summary]\` — use the id to promote/hydrate

### Tool quick reference

| Tool | When to use | Example |
|------|-------------|---------|
| \`recall(tags)\` | Find related context before starting work | \`recall(["auth", "user-prefs"])\` |
| \`promote(id)\` | Bring a recalled item into active context | After recall returns relevant items |
| \`demote(id)\` | Free up budget after you're done with something | After completing a subtask |
| \`hydrate(stub)\` | Need full content, not just summary | Complex code, detailed specs |
| \`remember(content, type)\` | Store insights, decisions, facts discovered — be proactive | Decisions, user prefs, architecture notes |
| \`pin(id)\` | Lock critical constraints that must survive eviction | User hard requirements only |
| \`history(query)\` | Resume past work or reference prior sessions | "What did we decide about X?" |

### Core loop

1. **Before diving in:** Glance at \`<veil-context>\`. If gaps exist, \`recall()\` with 1-3 semantic tags (what it's *about*: "user-constraints", "auth-flow", "error-handling").

2. **While working:** Reference stubs by ID when citing. \`hydrate()\` only when you need to reason over full content, not just acknowledge something exists.

3. **After completing a step:** \`demote()\` items you won't reference in the next few turns. Keep 5-7 items max unless actively synthesizing.

### What NOT to do
- Don't \`recall()\` the same tags repeatedly in one turn — results are cached
- Don't \`remember()\` raw file contents verbatim — summarize insights instead
- Don't \`pin()\` everything important — pin is for survival under pressure, not organization
- Don't ignore low-scoring items in checkpoint prompts — demote or re-engage them

### What to pin
Pin sparingly — only user preferences, hard constraints, or decisions that would cause harm if forgotten. If unsure, don't pin.

### When to remember (be proactive)
Use \`remember()\` throughout your work — don't wait to be asked. Store:
- **Decisions made**: "Chose X over Y because Z" — capture the reasoning
- **Facts discovered**: Architecture patterns, API behaviors, config details found while exploring
- **User preferences**: Coding style, tool preferences, constraints they mention
- **Non-obvious conclusions**: Insights from analysis, connections between components
- **Task context**: What you're working on and why, so future sessions can resume

Think: "If I started a new session, what would I wish I remembered?" Store that.

### Cross-session
Use \`history()\` when resuming work or referencing past sessions. Items from history can be \`promote()\`d into your active context.

When to use \`history()\`:
- Starting a session that continues prior work
- User references "what we did before" or "last time"
- You need context from a different project session
- Picking up after a long gap (days/weeks)

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

function _formatTokens(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k tokens`;
	}
	return `${n} tokens`;
}
