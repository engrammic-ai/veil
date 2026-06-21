/**
 * Subagent tool - delegate tasks to specialized agents
 */

import { discoverAgents } from "./agents.ts";
import { createSubagentContext, mergeSubagentContext } from "./context.ts";
import { IpcServer } from "./ipc.ts";
import { spawnSubagent } from "./spawn.ts";
import type { AgentConfig, AgentScope, ChildMessage } from "./types.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

export interface SubagentToolConfig {
	parentDbPath: string;
	parentSessionId: string;
	onEscalate?: (question: string, childTag: string) => Promise<string>;
	onCheckpoint?: (checkpoint: ChildMessage & { type: "checkpoint" }, childTag: string) => void;
	onProgress?: (progress: ChildMessage & { type: "progress" }, childTag: string) => void;
}

export interface TaskItem {
	agent: string;
	task: string;
	cwd?: string;
}

export interface ChainItem {
	agent: string;
	task: string;
	cwd?: string;
}

export interface SubagentParams {
	agent?: string;
	task?: string;
	tasks?: TaskItem[];
	chain?: ChainItem[];
	agentScope?: AgentScope;
	cwd?: string;
}

export interface SubagentResult {
	mode: "single" | "parallel" | "chain";
	success: boolean;
	output: string;
	results?: SingleResult[];
}

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	error?: string;
}

async function runSingleAgent(
	config: SubagentToolConfig,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => a.name).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			output: "",
			error: `Unknown agent: "${agentName}". Available: ${available}`,
		};
	}

	// Create context for this subagent
	const ctx = createSubagentContext(config.parentDbPath, config.parentSessionId, {
		tag: agentName,
		inheritWarm: agent.veil?.inheritWarm ?? true,
		enableVeilTools: agent.veil?.enableVeilTools ?? true,
	});

	// Start IPC server
	const ipcServer = new IpcServer(ctx.ipcPath);

	ipcServer.onMessage(async (msg) => {
		if (msg.type === "checkpoint" && config.onCheckpoint) {
			config.onCheckpoint(msg as ChildMessage & { type: "checkpoint" }, agentName);
		} else if (msg.type === "progress" && config.onProgress) {
			config.onProgress(msg as ChildMessage & { type: "progress" }, agentName);
		} else if (msg.type === "escalate" && config.onEscalate) {
			const answer = await config.onEscalate(msg.question, agentName);
			ipcServer.send({ version: 1, type: "respond", requestId: msg.requestId, answer });
		}
	});

	await ipcServer.start();

	try {
		// Spawn the subagent
		const result = await spawnSubagent(ctx, agent, {
			cwd,
			task,
			signal,
		});

		// Merge context back to parent
		await mergeSubagentContext(config.parentDbPath, ctx);

		// Parse final output from stdout (JSON mode)
		let finalOutput = "";
		for (const line of result.stdout) {
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const content = event.message.content;
					if (Array.isArray(content)) {
						for (const part of content) {
							if (part.type === "text") finalOutput = part.text;
						}
					}
				}
			} catch {
				// Not JSON, ignore
			}
		}

		return {
			agent: agentName,
			task,
			exitCode: result.exitCode,
			output: finalOutput || result.stderr,
			error: result.exitCode !== 0 ? result.stderr : undefined,
		};
	} finally {
		await ipcServer.close();
		await ctx.cleanup();
	}
}

/**
 * Execute subagent tool
 */
export async function executeSubagentTool(
	config: SubagentToolConfig,
	params: SubagentParams,
	cwd: string,
	signal?: AbortSignal,
): Promise<SubagentResult> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(cwd, agentScope);
	const agents = discovery.agents;

	// Validate mode
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

	if (modeCount !== 1) {
		return {
			mode: "single",
			success: false,
			output: "Invalid parameters. Provide exactly one mode: (agent + task), tasks array, or chain array.",
		};
	}

	// Single mode
	if (hasSingle) {
		const result = await runSingleAgent(config, agents, params.agent!, params.task!, params.cwd ?? cwd, signal);

		return {
			mode: "single",
			success: result.exitCode === 0,
			output: result.output,
			results: [result],
		};
	}

	// Chain mode
	if (hasChain) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (const step of params.chain!) {
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

			const result = await runSingleAgent(config, agents, step.agent, taskWithContext, step.cwd ?? cwd, signal);

			results.push(result);

			if (result.exitCode !== 0) {
				return {
					mode: "chain",
					success: false,
					output: `Chain stopped at ${step.agent}: ${result.error || result.output}`,
					results,
				};
			}

			previousOutput = result.output;
		}

		return {
			mode: "chain",
			success: true,
			output: previousOutput,
			results,
		};
	}

	// Parallel mode
	if (hasTasks) {
		if (params.tasks!.length > MAX_PARALLEL_TASKS) {
			return {
				mode: "parallel",
				success: false,
				output: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`,
			};
		}

		// Simple parallel execution with concurrency limit
		const results: SingleResult[] = [];
		const pending = [...params.tasks!];
		const running: Promise<void>[] = [];

		const runNext = async () => {
			while (pending.length > 0) {
				const task = pending.shift()!;
				const result = await runSingleAgent(config, agents, task.agent, task.task, task.cwd ?? cwd, signal);
				results.push(result);
			}
		};

		// Start workers up to concurrency limit
		const workers = Math.min(MAX_CONCURRENCY, params.tasks!.length);
		for (let i = 0; i < workers; i++) {
			running.push(runNext());
		}

		await Promise.all(running);

		const successCount = results.filter((r) => r.exitCode === 0).length;
		return {
			mode: "parallel",
			success: successCount === results.length,
			output: `Parallel: ${successCount}/${results.length} succeeded`,
			results,
		};
	}

	return {
		mode: "single",
		success: false,
		output: "Invalid parameters",
	};
}
