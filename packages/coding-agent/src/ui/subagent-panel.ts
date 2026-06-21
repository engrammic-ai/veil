import type { Component } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, formatTokens, renderToolHistory, statusIcon } from "./subagent-renderer.ts";
import {
	createAgentState,
	createInitialState,
	type SubagentPanelState,
	type SubagentState,
	updateAgentState,
} from "./subagent-state.ts";

export interface SubagentPanelTheme {
	border: (text: string) => string;
	selected: (text: string) => string;
	dim: (text: string) => string;
	error: (text: string) => string;
	success: (text: string) => string;
	warning: (text: string) => string;
}

const DEFAULT_THEME: SubagentPanelTheme = {
	border: (t) => t,
	selected: (t) => `\x1b[7m${t}\x1b[0m`,
	dim: (t) => `\x1b[2m${t}\x1b[0m`,
	error: (t) => `\x1b[31m${t}\x1b[0m`,
	success: (t) => `\x1b[32m${t}\x1b[0m`,
	warning: (t) => `\x1b[33m${t}\x1b[0m`,
};

export class SubagentPanel implements Component {
	private state: SubagentPanelState;
	private theme: SubagentPanelTheme;

	public onKill?: (tag: string) => void;
	public onPause?: (tag: string) => void;
	public onResume?: (tag: string) => void;
	public onEscalationAnswer?: (tag: string, requestId: string, answer: string) => void;

	constructor(mode: "single" | "parallel" | "chain", theme?: SubagentPanelTheme) {
		this.state = createInitialState(mode);
		this.theme = theme ?? DEFAULT_THEME;
	}

	addAgent(tag: string, task: string): void {
		this.state.agents.set(tag, createAgentState(tag, task));
	}

	updateAgent(tag: string, update: Partial<SubagentState>): void {
		this.state = updateAgentState(this.state, tag, update);
	}

	invalidate(): void {
		// No cached rendering state
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const innerWidth = width - 4;

		// Header
		const header = this.renderHeader(innerWidth);
		lines.push(this.theme.border(`+-- ${header} ${"─".repeat(Math.max(0, innerWidth - header.length - 5))}+`));
		lines.push(this.theme.border(`|${" ".repeat(width - 2)}|`));

		if (this.state.agents.size === 0) {
			lines.push(
				this.theme.border(`|  ${this.theme.dim("No subagents")}${" ".repeat(Math.max(0, innerWidth - 14))}  |`),
			);
		} else {
			const agentTags = Array.from(this.state.agents.keys());
			for (let i = 0; i < agentTags.length; i++) {
				const tag = agentTags[i]!;
				const agent = this.state.agents.get(tag)!;
				const isSelected = i === this.state.selectedIndex;
				const agentLines = this.renderAgent(agent, isSelected, innerWidth);
				for (const line of agentLines) {
					lines.push(
						this.theme.border(`|  ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))}  |`),
					);
				}
			}
		}

		lines.push(this.theme.border(`|${" ".repeat(width - 2)}|`));
		lines.push(this.theme.border(`+${"─".repeat(width - 2)}+`));

		return lines;
	}

	private renderHeader(_width: number): string {
		const { mode, agents } = this.state;
		if (mode === "parallel") {
			const done = Array.from(agents.values()).filter((a) => a.status === "complete").length;
			const running = Array.from(agents.values()).filter((a) => a.status === "running").length;
			return `Parallel: ${done}/${agents.size} done, ${running} running`;
		}
		if (mode === "chain") {
			const currentStep = Array.from(agents.values()).findIndex((a) => a.status === "running") + 1;
			return `Chain: Step ${currentStep || 1}/${agents.size}`;
		}
		return "Subagents";
	}

	private renderAgent(agent: SubagentState, isSelected: boolean, width: number): string[] {
		const lines: string[] = [];
		const icon = statusIcon(agent.status);
		const isExpanded = this.state.expandedAgent === agent.tag;
		const tokens = formatTokens(agent.tokens, isExpanded);
		const cost = formatCost(agent.cost);

		const prefix = isSelected ? "> " : "  ";
		let line = `${prefix}${icon} ${agent.tag}`;
		if (agent.turn > 0) line += ` [${agent.turn}t`;
		if (tokens) line += `, ${tokens}`;
		if (cost) line += `, ${cost}`;
		if (agent.turn > 0) line += "]";
		if (agent.status === "complete") line += " Done";
		if (agent.status === "error" && agent.error) line += ` ${this.theme.error(agent.error)}`;

		if (isSelected) {
			lines.push(this.theme.selected(truncateToWidth(line, width, "")));
		} else {
			lines.push(truncateToWidth(line, width, ""));
		}

		// Show last tool if running (collapsed view only)
		if (!isExpanded && agent.status === "running" && agent.lastTool) {
			lines.push(this.theme.dim(`     -> ${agent.lastTool}`));
		}

		// Escalation display (always show when escalating, even if not expanded)
		if (agent.status === "escalating" && agent.escalation) {
			lines.push("");
			lines.push(this.theme.warning(`  "${agent.escalation.question}"`));
			lines.push("");
			lines.push("  [y] Yes  [n] No  [o] Other...");
		}

		// Expanded view
		if (isExpanded) {
			lines.push("");
			lines.push(`  Task: ${truncateToWidth(agent.task, width - 8, "...")}`);
			lines.push(`  Status: ${agent.status} [${agent.turn} turns, ${tokens}, ${cost || "$0.000"}]`);
			lines.push("");

			if (agent.toolHistory.length > 0) {
				lines.push("  Live output:");
				const toolLines = renderToolHistory(agent.toolHistory, 5);
				for (const tl of toolLines) {
					lines.push(`    ${this.theme.dim(tl)}`);
				}
			}

			if (agent.output) {
				lines.push("");
				lines.push(`  ${agent.output.split("\n")[0]}`);
			}

			lines.push("");
			lines.push(this.theme.dim("  [x] Kill  [p] Pause  [Esc] Back"));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const selectedTag = this.getSelectedTag();
		const selectedAgent = selectedTag ? this.state.agents.get(selectedTag) : null;

		// Handle escalation answers first
		if (selectedAgent?.status === "escalating" && selectedAgent.escalation) {
			if (keyData === "y" || keyData === "Y") {
				this.answerEscalation(selectedTag!, selectedAgent.escalation.requestId, "yes");
				return;
			}
			if (keyData === "n" || keyData === "N") {
				this.answerEscalation(selectedTag!, selectedAgent.escalation.requestId, "no");
				return;
			}
		}

		if (kb.matches(keyData, "tui.select.up")) {
			this.selectPrev();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectNext();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.toggleExpand();
		} else if (keyData === "x" || keyData === "X") {
			this.killSelected();
		} else if (keyData === "p" || keyData === "P") {
			this.pauseSelected();
		} else if (keyData === "r" || keyData === "R") {
			this.resumeSelected();
		}
	}

	private selectNext(): void {
		const count = this.state.agents.size;
		if (count > 0) {
			this.state.selectedIndex = (this.state.selectedIndex + 1) % count;
		}
	}

	private selectPrev(): void {
		const count = this.state.agents.size;
		if (count > 0) {
			this.state.selectedIndex = (this.state.selectedIndex - 1 + count) % count;
		}
	}

	private toggleExpand(): void {
		const tag = this.getSelectedTag();
		if (tag) {
			this.state.expandedAgent = this.state.expandedAgent === tag ? null : tag;
		}
	}

	private killSelected(): void {
		const tag = this.getSelectedTag();
		if (tag && this.onKill) {
			this.onKill(tag);
		}
	}

	private pauseSelected(): void {
		const tag = this.getSelectedTag();
		if (tag && this.onPause) {
			this.onPause(tag);
		}
	}

	private resumeSelected(): void {
		const tag = this.getSelectedTag();
		if (tag && this.onResume) {
			this.onResume(tag);
		}
	}

	private answerEscalation(tag: string, requestId: string, answer: string): void {
		if (this.onEscalationAnswer) {
			this.onEscalationAnswer(tag, requestId, answer);
		}
		this.updateAgent(tag, { status: "running", escalation: undefined });
	}

	private getSelectedTag(): string | null {
		const tags = Array.from(this.state.agents.keys());
		return tags[this.state.selectedIndex] ?? null;
	}

	// IPC event handlers
	onCheckpoint(tag: string, turn: number, tokens: number, lastTool?: string): void {
		const agent = this.state.agents.get(tag);
		if (!agent) return;

		const updatedTokens = { ...agent.tokens, output: tokens };
		const toolHistory = lastTool ? [...agent.toolHistory, { name: lastTool }] : agent.toolHistory;

		this.updateAgent(tag, {
			status: "running",
			turn,
			tokens: updatedTokens,
			lastTool,
			toolHistory,
		});
	}

	onProgress(tag: string, message: string, _percent?: number): void {
		this.updateAgent(tag, { output: message });
	}

	onComplete(tag: string, result: string): void {
		this.updateAgent(tag, { status: "complete", output: result });
	}

	onError(tag: string, message: string): void {
		this.updateAgent(tag, { status: "error", error: message });
	}

	onEscalate(tag: string, requestId: string, question: string): void {
		this.updateAgent(tag, {
			status: "escalating",
			escalation: { requestId, question },
		});
	}

	getState(): SubagentPanelState {
		return this.state;
	}
}
