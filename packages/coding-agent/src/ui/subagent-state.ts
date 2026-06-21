export interface SubagentState {
	tag: string;
	status: "pending" | "running" | "complete" | "error" | "paused" | "escalating";
	turn: number;
	tokens: { input: number; output: number; cacheRead: number };
	cost: number;
	task: string;
	lastTool?: string;
	toolHistory: Array<{ name: string; args?: string }>;
	output?: string;
	error?: string;
	startedAt: number;
	escalation?: { requestId: string; question: string };
}

export interface SubagentPanelState {
	agents: Map<string, SubagentState>;
	selectedIndex: number;
	expandedAgent: string | null;
	showKillConfirm: string | null;
	mode: "single" | "parallel" | "chain";
}

export function createInitialState(mode: "single" | "parallel" | "chain"): SubagentPanelState {
	return {
		agents: new Map(),
		selectedIndex: 0,
		expandedAgent: null,
		showKillConfirm: null,
		mode,
	};
}

export function createAgentState(tag: string, task: string): SubagentState {
	return {
		tag,
		status: "pending",
		turn: 0,
		tokens: { input: 0, output: 0, cacheRead: 0 },
		cost: 0,
		task,
		toolHistory: [],
		startedAt: Date.now(),
	};
}

export function updateAgentState(
	state: SubagentPanelState,
	tag: string,
	update: Partial<SubagentState>,
): SubagentPanelState {
	const agents = new Map(state.agents);
	const existing = agents.get(tag);
	if (existing) {
		agents.set(tag, { ...existing, ...update });
	}
	return { ...state, agents };
}
