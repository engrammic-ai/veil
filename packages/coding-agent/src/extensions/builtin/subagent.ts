/**
 * Built-in Subagent Extension
 *
 * Delegate tasks to specialized subagents with isolated context windows.
 * Uses the @veil/subagent package for IPC, spawning, and context management.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentConfig,
	type ChildMessage,
	createSubagentContext,
	discoverAgents,
	IpcServer,
	spawnSubagent,
} from "@veil/subagent";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

// Agent discovery paths
const USER_AGENT_DIR = path.join(os.homedir(), ".veil", "agents");
const PROJECT_AGENT_DIR = ".veil/agents";

// Maximum concurrent subagents
const MAX_CONCURRENT = 4;

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

type SubagentInput = {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
};

interface ExecutionResult {
	success: boolean;
	output: string;
	tokens?: number;
	error?: string;
}

function getDbPath(cwd: string): string {
	return path.join(cwd, ".veil", "context.db");
}

async function executeSingleAgent(
	agentConfig: AgentConfig,
	task: string,
	cwd: string,
	sessionId: string,
	signal?: AbortSignal,
): Promise<ExecutionResult> {
	const dbPath = getDbPath(cwd);
	const subCtx = createSubagentContext(dbPath, sessionId, { tag: agentConfig.name });

	const ipcServer = new IpcServer(subCtx.ipcPath);
	await ipcServer.start();

	let totalTokens = 0;
	let lastOutput = "";

	ipcServer.onMessage((msg: ChildMessage) => {
		switch (msg.type) {
			case "checkpoint":
				totalTokens = msg.tokens;
				break;
			case "complete":
				lastOutput = msg.result;
				break;
			case "error":
				lastOutput = `Error: ${msg.message}`;
				break;
		}
	});

	try {
		const result = await spawnSubagent(subCtx, agentConfig, {
			cwd,
			task,
			signal,
		});

		await ipcServer.close();

		if (result.exitCode !== 0) {
			return {
				success: false,
				output: lastOutput || result.stderr || "Subagent failed",
				tokens: totalTokens,
				error: result.stderr,
			};
		}

		return {
			success: true,
			output: lastOutput || result.stdout.join("\n"),
			tokens: totalTokens,
		};
	} catch (err) {
		await ipcServer.close();
		return {
			success: false,
			output: "",
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		await subCtx.cleanup();
	}
}

async function executeParallel(
	agents: Map<string, AgentConfig>,
	tasks: Array<{ agent: string; task: string }>,
	cwd: string,
	sessionId: string,
	signal?: AbortSignal,
): Promise<ExecutionResult[]> {
	const results: ExecutionResult[] = [];

	// Run in batches to respect MAX_CONCURRENT
	for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
		const batch = tasks.slice(i, i + MAX_CONCURRENT);
		const batchPromises = batch.map(async (t) => {
			const agentConfig = agents.get(t.agent);
			if (!agentConfig) {
				return {
					success: false,
					output: "",
					error: `Agent not found: ${t.agent}`,
				};
			}
			return executeSingleAgent(agentConfig, t.task, cwd, sessionId, signal);
		});

		const batchResults = await Promise.all(batchPromises);
		results.push(...batchResults);
	}

	return results;
}

async function executeChain(
	agents: Map<string, AgentConfig>,
	chain: Array<{ agent: string; task: string }>,
	cwd: string,
	sessionId: string,
	signal?: AbortSignal,
): Promise<ExecutionResult> {
	let previous = "";

	for (const step of chain) {
		const agentConfig = agents.get(step.agent);
		if (!agentConfig) {
			return {
				success: false,
				output: previous,
				error: `Agent not found: ${step.agent}`,
			};
		}

		// Replace {previous} placeholder with prior output
		const task = step.task.replace(/\{previous\}/g, previous);
		const result = await executeSingleAgent(agentConfig, task, cwd, sessionId, signal);

		if (!result.success) {
			return result;
		}

		previous = result.output;
	}

	return {
		success: true,
		output: previous,
	};
}

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

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as SubagentInput;
			const cwd = ctx.cwd;
			const sessionId = ctx.sessionManager.getSessionId();

			// Discover available agents
			const discovery = discoverAgents(cwd, "both");
			const agentMap = new Map(discovery.agents.map((a) => [a.name, a]));

			if (agentMap.size === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No agents found. Create agent definitions in:\n- ${USER_AGENT_DIR}/\n- ${path.join(cwd, PROJECT_AGENT_DIR)}/\n\nExample agent file (scout.md):\n\`\`\`markdown\n---\nname: scout\ndescription: Fast codebase reconnaissance\ntools: read, grep, find\nmodel: claude-haiku-4-5\n---\n\nYou are a fast reconnaissance agent...\n\`\`\``,
						},
					],
					details: undefined,
				};
			}

			// Determine execution mode
			if (input.chain && input.chain.length > 0) {
				// Chain mode
				const result = await executeChain(agentMap, input.chain, cwd, sessionId, signal);
				return {
					content: [
						{
							type: "text" as const,
							text: result.success
								? `Chain completed:\n\n${result.output}`
								: `Chain failed: ${result.error}\n\nPartial output:\n${result.output}`,
						},
					],
					details: undefined,
				};
			}

			if (input.tasks && input.tasks.length > 0) {
				// Parallel mode
				const results = await executeParallel(agentMap, input.tasks, cwd, sessionId, signal);
				const outputs = results.map((r, i) => {
					const taskInfo = input.tasks![i];
					const header = `## ${taskInfo.agent}: ${taskInfo.task.slice(0, 50)}...`;
					return r.success ? `${header}\n\n${r.output}` : `${header}\n\nFailed: ${r.error}`;
				});

				const successCount = results.filter((r) => r.success).length;
				return {
					content: [
						{
							type: "text" as const,
							text: `Parallel execution: ${successCount}/${results.length} succeeded\n\n${outputs.join("\n\n---\n\n")}`,
						},
					],
					details: undefined,
				};
			}

			if (input.agent && input.task) {
				// Single mode
				const agentConfig = agentMap.get(input.agent);
				if (!agentConfig) {
					const available = Array.from(agentMap.keys()).join(", ");
					return {
						content: [
							{
								type: "text" as const,
								text: `Agent not found: ${input.agent}\n\nAvailable agents: ${available || "none"}`,
							},
						],
						details: undefined,
					};
				}

				const result = await executeSingleAgent(agentConfig, input.task, cwd, sessionId, signal);
				return {
					content: [
						{
							type: "text" as const,
							text: result.success
								? result.output
								: `Subagent failed: ${result.error}\n\nOutput:\n${result.output}`,
						},
					],
					details: undefined,
				};
			}

			// No valid input - list available agents
			const agentList = discovery.agents.map((a) => `- **${a.name}** (${a.source}): ${a.description}`).join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: `No task specified. Available agents:\n\n${agentList}\n\nUsage:\n- Single: \`{agent: "scout", task: "find auth code"}\`\n- Parallel: \`{tasks: [{agent: "scout", task: "..."}, ...]}\`\n- Chain: \`{chain: [{agent: "scout", task: "..."}, {agent: "reviewer", task: "review {previous}"}]}\``,
					},
				],
				details: undefined,
			};
		},
	});
}
