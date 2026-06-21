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
	type SubagentContext,
	spawnSubagent,
} from "@veil/subagent";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { SubagentPanel } from "../../ui/subagent-panel.ts";

// Agent discovery paths
const USER_AGENT_DIR = path.join(os.homedir(), ".veil", "agents");
const PROJECT_AGENT_DIR = ".veil/agents";

// Maximum concurrent subagents
const MAX_CONCURRENT = 4;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	model: Type.Optional(Type.String({ description: "Model override (e.g., 'fast', 'claude-haiku-4-5')" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
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
	model: Type.Optional(
		Type.String({
			description:
				"Model override. Use 'fast' for quick tasks, or a specific model ID. Omit to inherit from agent definition or parent session.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "For parallel mode: array of {agent, task, model?} to run concurrently",
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
	model?: string;
	tasks?: Array<{ agent: string; task: string; model?: string }>;
	chain?: Array<{ agent: string; task: string; model?: string }>;
};

interface ExecutionResult {
	success: boolean;
	output: string;
	tokens?: number;
	error?: string;
}

interface RunningAgent {
	ipcServer: IpcServer;
	subCtx: SubagentContext;
	abortController: AbortController;
}

function getDbPath(cwd: string): string {
	return path.join(cwd, ".veil", "context.db");
}

async function executeSingleAgentWithPanel(
	agentConfig: AgentConfig,
	task: string,
	cwd: string,
	sessionId: string,
	panel: SubagentPanel,
	runningAgents: Map<string, RunningAgent>,
	signal?: AbortSignal,
	modelOverride?: string,
): Promise<ExecutionResult> {
	const dbPath = getDbPath(cwd);
	const tag = agentConfig.name;
	const subCtx = createSubagentContext(dbPath, sessionId, { tag });

	// Apply model override if provided
	const effectiveConfig: AgentConfig = modelOverride ? { ...agentConfig, model: modelOverride } : agentConfig;

	const ipcServer = new IpcServer(subCtx.ipcPath);
	await ipcServer.start();

	// Create abort controller for this agent
	const agentAbort = new AbortController();
	if (signal?.aborted) {
		agentAbort.abort();
	} else {
		signal?.addEventListener("abort", () => agentAbort.abort(), { once: true });
	}

	// Track running agent
	runningAgents.set(tag, { ipcServer, subCtx, abortController: agentAbort });

	// Register agent in panel
	panel.addAgent(tag, task);

	let totalTokens = 0;
	let lastOutput = "";

	// Wire IPC events to panel
	ipcServer.onMessage((msg: ChildMessage) => {
		switch (msg.type) {
			case "checkpoint":
				totalTokens = msg.tokens;
				panel.onCheckpoint(tag, msg.turn, msg.tokens, msg.lastTool);
				break;
			case "progress":
				panel.onProgress(tag, msg.message, msg.percent);
				break;
			case "complete":
				lastOutput = msg.result;
				panel.onComplete(tag, msg.result);
				break;
			case "error":
				lastOutput = `Error: ${msg.message}`;
				panel.onError(tag, msg.message);
				break;
			case "escalate":
				panel.onEscalate(tag, msg.requestId, msg.question);
				break;
		}
	});

	try {
		const result = await spawnSubagent(subCtx, effectiveConfig, {
			cwd,
			task,
			signal: agentAbort.signal,
		});

		await ipcServer.close();
		runningAgents.delete(tag);

		if (result.exitCode !== 0) {
			panel.onError(tag, result.stderr || "Process exited with error");
			return {
				success: false,
				output: lastOutput || result.stderr || "Subagent failed",
				tokens: totalTokens,
				error: result.stderr,
			};
		}

		panel.onComplete(tag, lastOutput || "Done");
		return {
			success: true,
			output: lastOutput || result.stdout.join("\n"),
			tokens: totalTokens,
		};
	} catch (err) {
		await ipcServer.close();
		runningAgents.delete(tag);
		const errorMsg = err instanceof Error ? err.message : String(err);
		panel.onError(tag, errorMsg);
		return {
			success: false,
			output: "",
			error: errorMsg,
		};
	} finally {
		await subCtx.cleanup();
	}
}

async function executeParallelWithPanel(
	agents: Map<string, AgentConfig>,
	tasks: Array<{ agent: string; task: string; model?: string }>,
	cwd: string,
	sessionId: string,
	panel: SubagentPanel,
	runningAgents: Map<string, RunningAgent>,
	signal?: AbortSignal,
): Promise<ExecutionResult[]> {
	const results: ExecutionResult[] = [];

	// Run in batches to respect MAX_CONCURRENT
	for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
		const batch = tasks.slice(i, i + MAX_CONCURRENT);
		const batchPromises = batch.map(async (t, batchIdx) => {
			const agentConfig = agents.get(t.agent);
			if (!agentConfig) {
				// Use unique tag for missing agents
				const tag = `${t.agent}-${i + batchIdx}`;
				panel.addAgent(tag, t.task);
				panel.onError(tag, `Agent not found: ${t.agent}`);
				return {
					success: false,
					output: "",
					error: `Agent not found: ${t.agent}`,
				};
			}
			// Use unique tag if same agent appears multiple times
			const uniqueConfig = { ...agentConfig, name: `${agentConfig.name}-${i + batchIdx}` };
			return executeSingleAgentWithPanel(
				uniqueConfig,
				t.task,
				cwd,
				sessionId,
				panel,
				runningAgents,
				signal,
				t.model,
			);
		});

		const batchResults = await Promise.all(batchPromises);
		results.push(...batchResults);
	}

	return results;
}

async function executeChainWithPanel(
	agents: Map<string, AgentConfig>,
	chain: Array<{ agent: string; task: string; model?: string }>,
	cwd: string,
	sessionId: string,
	panel: SubagentPanel,
	runningAgents: Map<string, RunningAgent>,
	signal?: AbortSignal,
): Promise<ExecutionResult> {
	let previous = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i]!;
		const agentConfig = agents.get(step.agent);
		if (!agentConfig) {
			const tag = `${step.agent}-${i}`;
			panel.addAgent(tag, step.task);
			panel.onError(tag, `Agent not found: ${step.agent}`);
			return {
				success: false,
				output: previous,
				error: `Agent not found: ${step.agent}`,
			};
		}

		// Replace {previous} placeholder with prior output
		const task = step.task.replace(/\{previous\}/g, previous);
		// Use step index in tag for chain uniqueness
		const uniqueConfig = { ...agentConfig, name: `${agentConfig.name}-step${i + 1}` };
		const result = await executeSingleAgentWithPanel(
			uniqueConfig,
			task,
			cwd,
			sessionId,
			panel,
			runningAgents,
			signal,
			step.model,
		);

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
			const agentMap = new Map<string, AgentConfig>(discovery.agents.map((a) => [a.name, a]));

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

			// Determine mode and create panel
			const mode = input.chain?.length ? "chain" : input.tasks?.length ? "parallel" : "single";
			const panel = new SubagentPanel(mode);
			const runningAgents = new Map<string, RunningAgent>();

			// Wire panel callbacks to control running agents
			panel.onKill = (tag: string) => {
				const running = runningAgents.get(tag);
				if (running) {
					running.ipcServer.send({ version: 1, type: "abort", reason: "User killed" });
					running.abortController.abort();
				}
			};

			panel.onPause = (tag: string) => {
				const running = runningAgents.get(tag);
				if (running) {
					running.ipcServer.send({ version: 1, type: "interrupt" });
					panel.updateAgent(tag, { status: "paused" });
				}
			};

			panel.onResume = (tag: string) => {
				const running = runningAgents.get(tag);
				if (running) {
					running.ipcServer.send({ version: 1, type: "resume" });
					panel.updateAgent(tag, { status: "running" });
				}
			};

			panel.onEscalationAnswer = (tag: string, requestId: string, answer: string) => {
				const running = runningAgents.get(tag);
				if (running) {
					running.ipcServer.send({ version: 1, type: "respond", requestId, answer });
				}
			};

			// Set panel as widget if UI is available
			if (ctx.hasUI) {
				ctx.ui.setWidget("subagent-panel", (_tui, _theme) => panel, { placement: "aboveEditor" });
			}

			try {
				// Execute based on mode
				if (input.chain && input.chain.length > 0) {
					const result = await executeChainWithPanel(
						agentMap,
						input.chain,
						cwd,
						sessionId,
						panel,
						runningAgents,
						signal,
					);
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
					const results = await executeParallelWithPanel(
						agentMap,
						input.tasks,
						cwd,
						sessionId,
						panel,
						runningAgents,
						signal,
					);
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

					const result = await executeSingleAgentWithPanel(
						agentConfig,
						input.task,
						cwd,
						sessionId,
						panel,
						runningAgents,
						signal,
						input.model,
					);
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
			} finally {
				// Clear widget when done
				if (ctx.hasUI) {
					ctx.ui.setWidget("subagent-panel", undefined);
				}
			}
		},
	});
}
