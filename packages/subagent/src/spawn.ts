/**
 * Process spawning for subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, SubagentContext } from "./types.ts";

// Common preamble prepended to all subagent system prompts
const SUBAGENT_PREAMBLE = `You are a subagent spawned to complete a specific task. Return your findings directly.

CRITICAL CONSTRAINTS:
- Avoid reflexive agreement. Never use phrases like "You're absolutely right", "Great catch", "That makes sense", "Good point"
- Never praise the user or parent agent
- State facts and findings directly without social pleasantries
- If something is already done or doesn't need action, just say so plainly
- Be terse. No filler. No hedging unless genuinely uncertain.
- NEVER use bash for file writes (echo >>, cat << EOF, sed -i, tee) — use write/edit tools

`;

/**
 * Build CLI arguments for spawning a veil child process
 */
export function getVeilInvocation(ctx: SubagentContext, agent: AgentConfig): string[] {
	const args = [
		"veil",
		"--veil-parent-db",
		ctx.parentDbPath,
		"--veil-session-id",
		ctx.sessionId,
		"--veil-tag",
		ctx.tag,
		"--veil-ipc",
		ctx.ipcPath,
		"--mode",
		"json",
		"--no-session",
	];

	if (agent.model) {
		args.push("--model", agent.model);
	}

	// Build tools list from builtinToolNames + extSelectors
	const tools: string[] = [];
	if (agent.builtinToolNames && agent.builtinToolNames.length > 0) {
		tools.push(...agent.builtinToolNames);
	}
	if (agent.extSelectors && agent.extSelectors.length > 0) {
		tools.push(...agent.extSelectors);
	}
	if (tools.length > 0) {
		args.push("--tools", tools.join(","));
	}

	// Pass system prompt with anti-sycophancy preamble
	if (agent.systemPrompt) {
		args.push("--system-prompt", SUBAGENT_PREAMBLE + agent.systemPrompt);
	}

	return args;
}

/**
 * Get the veil binary invocation
 */
function getVeilBinary(): { command: string; args: string[] } {
	// Check for tsx (running from sources via veil-test.sh)
	// Look for tsx in the argv or if we're running a .ts file directly
	const scriptArg = process.argv[1] || "";
	const isRunningTs = scriptArg.endsWith(".ts") || process.argv.some((a) => a.includes("tsx"));

	if (isRunningTs) {
		// Find cli.ts by walking up from the script location
		const scriptDir = path.dirname(scriptArg);
		// Try common locations
		const candidates = [
			path.resolve(scriptDir, "cli.ts"), // Same dir
			path.resolve(scriptDir, "../cli.ts"), // Up one
			path.resolve(scriptDir, "../../coding-agent/src/cli.ts"), // From subagent
		];
		for (const cliPath of candidates) {
			if (fs.existsSync(cliPath)) {
				// Use npx tsx to run the TypeScript file
				return { command: "npx", args: ["tsx", cliPath] };
			}
		}
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

	if (!isGenericRuntime) {
		return { command: process.execPath, args: [] };
	}

	return { command: "veil", args: [] };
}

export interface SpawnOptions {
	cwd: string;
	task: string;
	onStdout?: (line: string) => void;
	onStderr?: (data: string) => void;
	signal?: AbortSignal;
}

export interface SpawnResult {
	exitCode: number;
	stdout: string[];
	stderr: string;
}

/**
 * Spawn a subagent process
 */
export async function spawnSubagent(
	ctx: SubagentContext,
	agent: AgentConfig,
	options: SpawnOptions,
): Promise<SpawnResult> {
	const invocation = getVeilBinary();
	const cliArgs = getVeilInvocation(ctx, agent);

	// Remove 'veil' from cliArgs (first element) since we handle binary separately
	const args = [...invocation.args, ...cliArgs.slice(1), `Task: ${options.task}`];

	// Debug: log what we're spawning
	const cmdLine = `${invocation.command} ${args.join(" ")}`;
	options.onStderr?.(`[subagent] Spawning: ${cmdLine.slice(0, 200)}\n`);

	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(invocation.command, args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			options.onStderr?.(`[subagent] Spawn failed: ${msg}\n`);
			resolve({ exitCode: 1, stdout: [], stderr: `Spawn failed: ${msg}` });
			return;
		}

		const stdout: string[] = [];
		let stderr = "";
		let buffer = "";

		// stdio is ["ignore", "pipe", "pipe"] so stdout/stderr are guaranteed
		proc.stdout!.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				stdout.push(line);
				options.onStdout?.(line);
			}
		});

		proc.stderr!.on("data", (data) => {
			stderr += data.toString();
			options.onStderr?.(data.toString());
		});

		proc.on("close", (code) => {
			if (buffer.trim()) {
				stdout.push(buffer);
				options.onStdout?.(buffer);
			}
			resolve({ exitCode: code ?? 0, stdout, stderr });
		});

		proc.on("error", (err) => {
			const msg = `Spawn error: ${err.message}`;
			options.onStderr?.(`[subagent] ${msg}\n`);
			resolve({ exitCode: 1, stdout, stderr: stderr + msg });
		});

		if (options.signal) {
			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			if (options.signal.aborted) {
				killProc();
			} else {
				options.signal.addEventListener("abort", killProc, { once: true });
			}
		}
	});
}
