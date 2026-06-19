/**
 * `veil embedder` CLI: manage the shared embedding model server.
 *
 * Subcommands: start, stop, status, logs, config, config set <key=value>
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
	CONFIG_FILE,
	EmbedderClient,
	type EmbedderConfig,
	getServerPid,
	isServerProcessRunning,
	LOG_DIR,
	LOG_FILE,
	loadConfig,
	MODEL_REGISTRY,
	type ModelTier,
	type ServerStatus,
	saveConfig,
} from "@veil/embedder";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";

const VALID_TIERS: ModelTier[] = ["none", "light", "balanced", "quality", "max", "ollama"];

function usage(): string {
	return `${chalk.bold("Usage:")}
  ${APP_NAME} embedder start              Start the embedder server in the background
  ${APP_NAME} embedder stop               Stop the running embedder server
  ${APP_NAME} embedder status             Show server status
  ${APP_NAME} embedder logs [-n <lines>]  Show recent server log output
  ${APP_NAME} embedder config             Show the current config
  ${APP_NAME} embedder config set <key=value>   Update config (e.g. tier=quality)`;
}

function resolveServerPath(): string | undefined {
	// Fall back to package location (for development)
	const require = createRequire(import.meta.url);
	try {
		const entry = require.resolve("@veil/embedder");
		const serverPath = `${dirname(entry)}/server.js`;
		if (existsSync(serverPath)) {
			return serverPath;
		}
	} catch {}

	// Check installed location first (~/.local/share/veil/embedder/server.js)
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home) {
		const installedPath = `${home}/.local/share/veil/embedder/server.js`;
		if (existsSync(installedPath)) {
			return installedPath;
		}
	}

	return undefined;
}

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${m}m ${sec}s`;
	if (m > 0) return `${m}m ${sec}s`;
	return `${sec}s`;
}

async function cmdStart(client: EmbedderClient): Promise<number> {
	if (await client.isRunning()) {
		console.log(chalk.green("Embedder server is already running."));
		return 0;
	}

	const config = loadConfig();
	if (config.tier === "none") {
		console.error(chalk.yellow("Embedder is disabled (tier=none). Set a tier first:"));
		console.error(chalk.dim(`  ${APP_NAME} embedder config set tier=balanced`));
		return 1;
	}

	const serverPath = resolveServerPath();
	if (!serverPath) {
		console.error(chalk.red("Embedder server binary not found. Is @veil/embedder built?"));
		return 1;
	}

	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}

	// The server tees its own console output to LOG_FILE, so discard the pipe
	// to avoid duplicate log lines.
	const child = spawn("node", [serverPath], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	process.stdout.write(chalk.dim("Starting embedder server"));
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
		process.stdout.write(chalk.dim("."));
		if (await client.isRunning()) {
			process.stdout.write("\n");
			const spec = MODEL_REGISTRY[config.tier];
			console.log(chalk.green(`Embedder server started (tier=${config.tier}${spec ? `, ${spec.name}` : ""}).`));
			console.log(chalk.dim(`  Logs: ${LOG_FILE}`));
			return 0;
		}
	}

	process.stdout.write("\n");
	console.error(chalk.red("Embedder server did not become ready within 30s. Check logs:"));
	console.error(chalk.dim(`  ${APP_NAME} embedder logs`));
	return 1;
}

function cmdStop(): number {
	const pid = getServerPid();
	if (!pid || !isServerProcessRunning()) {
		console.log(chalk.yellow("Embedder server is not running."));
		return 0;
	}

	try {
		process.kill(pid, "SIGTERM");
		console.log(chalk.green(`Sent SIGTERM to embedder server (pid ${pid}).`));
		return 0;
	} catch (err) {
		console.error(chalk.red(`Failed to stop embedder server: ${err instanceof Error ? err.message : String(err)}`));
		return 1;
	}
}

async function cmdStatus(client: EmbedderClient): Promise<number> {
	const running = await client.isRunning();
	if (!running) {
		console.log(chalk.bold("Embedder:"), chalk.red("stopped"));
		if (getServerPid() !== null && isServerProcessRunning()) {
			console.log(chalk.dim("  (process is alive but not responding to HTTP yet)"));
		}
		const config = loadConfig();
		console.log(chalk.dim(`  Configured tier: ${config.tier}`));
		return 0;
	}

	const status: ServerStatus | null = await client.status();
	const pid = getServerPid();
	console.log(chalk.bold("Embedder:"), chalk.green("running"));
	if (pid) console.log(`  PID:           ${pid}`);
	if (status) {
		console.log(`  Model loaded:  ${status.ready ? chalk.green(status.model?.name ?? "yes") : chalk.dim("not yet")}`);
		if (status.model) {
			console.log(`  Tier:          ${status.model.tier} (${status.model.dimensions}d)`);
		}
		console.log(`  Uptime:        ${formatUptime(status.uptime)}`);
		console.log(`  Requests:      ${status.requestCount}`);
	}
	return 0;
}

function cmdLogs(lines: number): number {
	if (!existsSync(LOG_FILE)) {
		console.log(chalk.dim(`No log file yet at ${LOG_FILE}`));
		return 0;
	}
	const content = readFileSync(LOG_FILE, "utf-8");
	const all = content.split("\n");
	const tail = all.slice(Math.max(0, all.length - lines - 1));
	console.log(tail.join("\n").trimEnd());
	return 0;
}

function cmdConfigShow(): number {
	const config = loadConfig();
	console.log(chalk.bold("Embedder config"), chalk.dim(`(${CONFIG_FILE})`));
	console.log(`  tier:          ${config.tier}`);
	console.log(`  port:          ${config.port}`);
	console.log(`  cachePath:     ${config.cachePath}`);
	console.log(`  idleTimeoutMs: ${config.idleTimeoutMs} (${Math.round(config.idleTimeoutMs / 60000)}m)`);
	const spec = MODEL_REGISTRY[config.tier];
	if (spec) {
		console.log(chalk.dim(`  model:         ${spec.name} — ${spec.size}, ${spec.ram}, ${spec.dimensions}d`));
	}
	return 0;
}

function cmdConfigSet(assignment: string | undefined): number {
	if (!assignment || !assignment.includes("=")) {
		console.error(chalk.red("Expected key=value (e.g. tier=quality)."));
		return 1;
	}

	const eq = assignment.indexOf("=");
	const key = assignment.slice(0, eq).trim();
	const value = assignment.slice(eq + 1).trim();
	const config = loadConfig();

	switch (key) {
		case "tier": {
			if (!VALID_TIERS.includes(value as ModelTier)) {
				console.error(chalk.red(`Invalid tier "${value}". Valid: ${VALID_TIERS.join(", ")}`));
				return 1;
			}
			config.tier = value as ModelTier;
			break;
		}
		case "port": {
			const port = Number.parseInt(value, 10);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				console.error(chalk.red(`Invalid port "${value}".`));
				return 1;
			}
			config.port = port;
			break;
		}
		case "cachePath":
			config.cachePath = value;
			break;
		case "idleTimeoutMs": {
			const n = Number.parseInt(value, 10);
			if (!Number.isInteger(n) || n < 0) {
				console.error(chalk.red(`Invalid idleTimeoutMs "${value}".`));
				return 1;
			}
			config.idleTimeoutMs = n;
			break;
		}
		default:
			console.error(chalk.red(`Unknown config key "${key}". Valid: tier, port, cachePath, idleTimeoutMs`));
			return 1;
	}

	saveConfig(config);
	console.log(chalk.green(`Set ${key}=${value}.`));
	if (key === "tier" || key === "port") {
		console.log(chalk.dim(`Restart the server to apply: ${APP_NAME} embedder stop && ${APP_NAME} embedder start`));
	}
	return 0;
}

/**
 * Handle `veil embedder ...`. Returns true if the command was recognized.
 */
export async function handleEmbedderCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "embedder") {
		return false;
	}

	const sub = args[1];
	if (!sub || sub === "-h" || sub === "--help") {
		console.log(usage());
		return true;
	}

	const config: EmbedderConfig = loadConfig();
	const client = new EmbedderClient({ port: config.port, autoStart: false });

	let exitCode = 0;
	switch (sub) {
		case "start":
			exitCode = await cmdStart(client);
			break;
		case "stop":
			exitCode = cmdStop();
			break;
		case "status":
			exitCode = await cmdStatus(client);
			break;
		case "logs": {
			let lines = 40;
			const nIdx = args.findIndex((a) => a === "-n" || a === "--lines");
			if (nIdx !== -1 && args[nIdx + 1]) {
				const parsed = Number.parseInt(args[nIdx + 1], 10);
				if (Number.isInteger(parsed) && parsed > 0) lines = parsed;
			}
			exitCode = cmdLogs(lines);
			break;
		}
		case "config":
			exitCode = args[2] === "set" ? cmdConfigSet(args[3]) : cmdConfigShow();
			break;
		default:
			console.error(chalk.red(`Unknown embedder command "${sub}".`));
			console.error(usage());
			exitCode = 1;
	}

	process.exitCode = exitCode;
	return true;
}
