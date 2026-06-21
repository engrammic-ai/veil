import { describe, expect, it } from "vitest";
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
