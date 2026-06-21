import { describe, expect, it } from "vitest";
import { getVeilInvocation } from "./spawn.ts";
import type { AgentConfig, SubagentContext } from "./types.ts";

describe("getVeilInvocation", () => {
	it("builds correct CLI args", () => {
		const ctx: SubagentContext = {
			sessionId: "parent:scout:123",
			parentDbPath: "/tmp/parent.db",
			childDbPath: "/tmp/child.db",
			ipcPath: "/tmp/veil-ipc.sock",
			tag: "scout",
			cleanup: async () => {},
		};

		const agent: AgentConfig = {
			name: "scout",
			description: "Fast recon",
			model: "claude-haiku-4-5",
			tools: ["read", "grep"],
			systemPrompt: "You are a scout",
			source: "user",
			filePath: "/path/to/scout.md",
		};

		const args = getVeilInvocation(ctx, agent);

		expect(args).toContain("veil");
		expect(args).toContain("--veil-parent-db");
		expect(args).toContain("/tmp/parent.db");
		expect(args).toContain("--veil-tag");
		expect(args).toContain("scout");
		expect(args).toContain("--model");
		expect(args).toContain("claude-haiku-4-5");
		expect(args).toContain("--tools");
		expect(args).toContain("read,grep");
	});

	it("includes veil-tools false when disabled", () => {
		const ctx: SubagentContext = {
			sessionId: "parent:worker:123",
			parentDbPath: "/tmp/parent.db",
			childDbPath: "/tmp/child.db",
			ipcPath: "/tmp/veil-ipc.sock",
			tag: "worker",
			cleanup: async () => {},
		};

		const agent: AgentConfig = {
			name: "worker",
			description: "Worker agent",
			systemPrompt: "You are a worker",
			source: "user",
			filePath: "/path/to/worker.md",
			veil: { enableVeilTools: false },
		};

		const args = getVeilInvocation(ctx, agent);

		expect(args).toContain("--veil-tools");
		expect(args).toContain("false");
	});
});
