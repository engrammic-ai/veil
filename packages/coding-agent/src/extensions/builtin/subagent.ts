/**
 * Built-in Subagent Extension
 *
 * Delegate tasks to specialized subagents with isolated context windows.
 * Uses the @veil/subagent package for IPC, spawning, and context management.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

// Agent discovery paths
const USER_AGENT_DIR = path.join(os.homedir(), ".veil", "agents");
const PROJECT_AGENT_DIR = ".veil/agents";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: `Agent name (e.g., 'scout', 'reviewer'). Must match an agent definition in ${USER_AGENT_DIR}/ or ${PROJECT_AGENT_DIR}/`,
		}),
	),
	task: Type.Optional(
		Type.String({
			description: "Task description for the agent",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "For parallel mode: array of {agent, task} to run concurrently",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "For chain mode: sequential agents, use {previous} in task to reference prior output",
		}),
	),
});

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context windows.",
			`Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).`,
			`Agents are loaded from ${USER_AGENT_DIR}/ (user) or ${PROJECT_AGENT_DIR}/ (project).`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			// TODO: Implement in subsequent tasks using @veil/subagent
			return {
				content: [{ type: "text" as const, text: "Subagent tool not yet implemented" }],
				details: undefined,
			};
		},
	});
}
