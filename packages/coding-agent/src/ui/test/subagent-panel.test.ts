import { describe, expect, it } from "vitest";
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
