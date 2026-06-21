import type { SubagentState } from "./subagent-state.ts";

const STATUS_ICONS: Record<SubagentState["status"], string> = {
	pending: "?",
	running: "o",
	complete: "*",
	error: "X",
	paused: "=",
	escalating: "!",
};

export function statusIcon(status: SubagentState["status"]): string {
	return STATUS_ICONS[status];
}

export function formatTokens(tokens: SubagentState["tokens"], expanded: boolean): string {
	const total = tokens.input + tokens.output;
	if (!expanded) {
		if (total >= 1000) {
			return `${(total / 1000).toFixed(1)}k`;
		}
		return `${total}`;
	}
	// Expanded: "up500 down300 R200"
	const parts: string[] = [];
	if (tokens.input > 0) parts.push(`up${tokens.input}`);
	if (tokens.output > 0) parts.push(`down${tokens.output}`);
	if (tokens.cacheRead > 0) parts.push(`R${tokens.cacheRead}`);
	return parts.join(" ") || "0";
}

export function formatCost(cost: number): string {
	if (cost < 0.01) return "";
	return `$${cost.toFixed(3)}`;
}

export function renderToolHistory(history: SubagentState["toolHistory"], maxItems: number = 5): string[] {
	const recent = history.slice(-maxItems);
	return recent.map((t) => `-> ${t.name}${t.args ? ` ${t.args}` : ""}`);
}
