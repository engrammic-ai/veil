import type { ChildMessage, IpcServer } from "@veil/subagent";
import { SubagentPanel } from "./subagent-panel.ts";
import type { SubagentState } from "./subagent-state.ts";

export interface SubagentRenderContext {
	ipcServer: IpcServer;
	tag: string;
	onKill: (tag: string) => void;
	onPause: (tag: string) => void;
	onResume: (tag: string) => void;
	onEscalationAnswer: (tag: string, requestId: string, answer: string) => void;
	onRetry?: (tag: string) => void;
	onSkip?: (tag: string) => void;
}

export function createSubagentRenderer(
	mode: "single" | "parallel" | "chain",
	context: SubagentRenderContext,
): SubagentPanel {
	const panel = new SubagentPanel(mode);
	const { tag } = context;

	// Wire up IPC events (IpcServer.onMessage passes only msg, tag comes from closure)
	context.ipcServer.onMessage((msg: ChildMessage) => {
		switch (msg.type) {
			case "checkpoint":
				panel.onCheckpoint(tag, msg.turn, msg.tokens, msg.lastTool);
				break;
			case "progress":
				panel.onProgress(tag, msg.message, msg.percent);
				break;
			case "complete":
				panel.onComplete(tag, msg.result);
				break;
			case "error":
				panel.onError(tag, msg.message);
				break;
			case "escalate":
				panel.onEscalate(tag, msg.requestId, msg.question);
				break;
		}
	});

	// Wire up action callbacks
	panel.onKill = context.onKill;
	panel.onPause = context.onPause;
	panel.onResume = context.onResume;
	panel.onEscalationAnswer = context.onEscalationAnswer;
	if (context.onRetry) panel.onRetry = context.onRetry;
	if (context.onSkip) panel.onSkip = context.onSkip;

	return panel;
}

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
