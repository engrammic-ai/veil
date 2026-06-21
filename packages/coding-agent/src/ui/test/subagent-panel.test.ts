import { describe, expect, it } from "vitest";
import { SubagentPanel } from "../subagent-panel.ts";
import { formatCost, formatTokens, statusIcon } from "../subagent-renderer.ts";
import { createAgentState, createInitialState, updateAgentState } from "../subagent-state.ts";

describe("subagent-state", () => {
	it("creates empty initial state", () => {
		const state = createInitialState("single");
		expect(state.agents.size).toBe(0);
		expect(state.selectedIndex).toBe(0);
		expect(state.expandedAgent).toBeNull();
		expect(state.mode).toBe("single");
	});

	it("updates agent state immutably", () => {
		const state = createInitialState("parallel");
		state.agents.set("scout", createAgentState("scout", "Find files"));

		const updated = updateAgentState(state, "scout", { status: "running", turn: 1 });

		expect(updated.agents.get("scout")?.status).toBe("running");
		expect(updated.agents.get("scout")?.turn).toBe(1);
		expect(state.agents.get("scout")?.status).toBe("pending"); // original unchanged
	});
});

describe("subagent-renderer", () => {
	it("returns correct status icons", () => {
		expect(statusIcon("pending")).toBe("?");
		expect(statusIcon("running")).toBe("o");
		expect(statusIcon("complete")).toBe("*");
		expect(statusIcon("error")).toBe("X");
		expect(statusIcon("paused")).toBe("=");
		expect(statusIcon("escalating")).toBe("!");
	});

	it("formats tokens correctly", () => {
		const tokens = { input: 500, output: 300, cacheRead: 200 };
		expect(formatTokens(tokens, false)).toBe("800");
		expect(formatTokens({ input: 1200, output: 800, cacheRead: 0 }, false)).toBe("2.0k");
		expect(formatTokens(tokens, true)).toBe("up500 down300 R200");
	});

	it("formats cost correctly", () => {
		expect(formatCost(0)).toBe("");
		expect(formatCost(0.005)).toBe("");
		expect(formatCost(0.01)).toBe("$0.010");
		expect(formatCost(1.5)).toBe("$1.500");
	});
});

describe("SubagentPanel", () => {
	it("renders empty state", () => {
		const panel = new SubagentPanel("single");
		const lines = panel.render(60);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes("Subagents"))).toBe(true);
	});

	it("renders agents with status icons", () => {
		const panel = new SubagentPanel("parallel");
		panel.addAgent("scout", "Find files");
		panel.updateAgent("scout", { status: "running", turn: 2, tokens: { input: 500, output: 300, cacheRead: 0 } });

		const lines = panel.render(60);
		const agentLine = lines.find((l) => l.includes("scout"));
		expect(agentLine).toBeDefined();
		expect(agentLine).toMatch(/o\s+scout/); // 'o' is running icon
		expect(agentLine).toMatch(/2t/); // turn count
	});
});

describe("SubagentPanel keyboard", () => {
	it("navigates with up/down and wraps", () => {
		const panel = new SubagentPanel("parallel");
		panel.addAgent("scout-a", "Task A");
		panel.addAgent("scout-b", "Task B");
		panel.addAgent("scout-c", "Task C");

		expect(panel.getState().selectedIndex).toBe(0);

		// Down arrow
		panel.handleInput("\x1b[B");
		expect(panel.getState().selectedIndex).toBe(1);

		panel.handleInput("\x1b[B");
		expect(panel.getState().selectedIndex).toBe(2);

		// Wrap to top
		panel.handleInput("\x1b[B");
		expect(panel.getState().selectedIndex).toBe(0);

		// Up arrow wraps to bottom
		panel.handleInput("\x1b[A");
		expect(panel.getState().selectedIndex).toBe(2);
	});

	it("toggles expand with Enter", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		expect(panel.getState().expandedAgent).toBeNull();

		panel.handleInput("\r"); // Enter
		expect(panel.getState().expandedAgent).toBe("scout");

		panel.handleInput("\r"); // Toggle off
		expect(panel.getState().expandedAgent).toBeNull();
	});

	it("calls onKill when x pressed", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		let killedTag: string | null = null;
		panel.onKill = (tag) => {
			killedTag = tag;
		};

		panel.handleInput("x");
		expect(killedTag).toBe("scout");
	});

	it("calls onPause when p pressed and onResume when r pressed", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		let pausedTag: string | null = null;
		let resumedTag: string | null = null;
		panel.onPause = (tag) => {
			pausedTag = tag;
		};
		panel.onResume = (tag) => {
			resumedTag = tag;
		};

		panel.handleInput("p");
		expect(pausedTag).toBe("scout");

		panel.handleInput("r");
		expect(resumedTag).toBe("scout");
	});

	it("shows escalation question", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");
		panel.updateAgent("scout", {
			status: "escalating",
			escalation: {
				requestId: "e1",
				question: "Should I include deprecated auth methods?",
			},
		});

		const lines = panel.render(70);
		expect(lines.some((l) => l.includes("!"))).toBe(true); // escalating icon
		expect(lines.some((l) => l.includes("deprecated auth"))).toBe(true);
	});

	it("calls onEscalationAnswer when y/n pressed", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");
		panel.updateAgent("scout", {
			status: "escalating",
			escalation: { requestId: "e1", question: "Include deprecated?" },
		});

		let answered: { tag: string; id: string; answer: string } | null = null;
		panel.onEscalationAnswer = (tag, id, answer) => {
			answered = { tag, id, answer };
		};

		panel.handleInput("y");
		expect(answered).toEqual({ tag: "scout", id: "e1", answer: "yes" });
		expect(panel.getState().agents.get("scout")?.status).toBe("running");
	});

	it("updates state on checkpoint", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		panel.onCheckpoint("scout", 2, 500, "grep");

		const agent = panel.getState().agents.get("scout");
		expect(agent?.turn).toBe(2);
		expect(agent?.lastTool).toBe("grep");
		expect(agent?.status).toBe("running");
		expect(agent?.toolHistory).toContainEqual({ name: "grep" });
	});

	it("updates state on complete", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");
		panel.updateAgent("scout", { status: "running" });

		panel.onComplete("scout", "Found 5 files");

		const agent = panel.getState().agents.get("scout");
		expect(agent?.status).toBe("complete");
		expect(agent?.output).toBe("Found 5 files");
	});

	it("updates state on error", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		panel.onError("scout", "Rate limit exceeded");

		const agent = panel.getState().agents.get("scout");
		expect(agent?.status).toBe("error");
		expect(agent?.error).toBe("Rate limit exceeded");
	});

	it("updates state on escalate", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		panel.onEscalate("scout", "req123", "Should I continue?");

		const agent = panel.getState().agents.get("scout");
		expect(agent?.status).toBe("escalating");
		expect(agent?.escalation?.requestId).toBe("req123");
		expect(agent?.escalation?.question).toBe("Should I continue?");
	});

	it("updates state on progress", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find files");

		panel.onProgress("scout", "Scanning directories...", 50);

		const agent = panel.getState().agents.get("scout");
		expect(agent?.output).toBe("Scanning directories...");
	});

	it("no-ops on unknown tag", () => {
		const panel = new SubagentPanel("single");
		// Should not throw
		panel.onCheckpoint("unknown", 1, 100, "grep");
		panel.onProgress("unknown", "msg");
		panel.onComplete("unknown", "result");
		panel.onError("unknown", "err");
		panel.onEscalate("unknown", "req1", "question?");
	});

	it("shows expanded view with tool history", () => {
		const panel = new SubagentPanel("single");
		panel.addAgent("scout", "Find all controller files");
		panel.updateAgent("scout", {
			status: "running",
			turn: 3,
			tokens: { input: 500, output: 300, cacheRead: 200 },
			cost: 0.008,
			toolHistory: [
				{ name: "grep", args: "/controller/" },
				{ name: "read", args: "src/api/userController.ts" },
			],
		});

		// Expand
		panel.handleInput("\r");

		const lines = panel.render(70);
		expect(lines.some((l) => l.includes("Find all controller files"))).toBe(true);
		expect(lines.some((l) => l.includes("up500"))).toBe(true);
		expect(lines.some((l) => l.includes("grep"))).toBe(true);
	});
});
