#!/usr/bin/env node
/**
 * Veil Embedder Server
 *
 * Persistent model server that caches embedding models and serves requests
 * over HTTP. Auto-scales down after idle timeout.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { configureCacheDir, createEmbedder, type Embedder } from "./embedder.ts";
import {
	DEFAULT_CONFIG,
	type EmbedderConfig,
	type EmbedRequest,
	type EmbedResponse,
	MODEL_REGISTRY,
	type ModelTier,
	type ServerStatus,
} from "./types.ts";

const CONFIG_DIR = join(homedir(), ".config", "veil");
const CONFIG_FILE = join(CONFIG_DIR, "embedder.json");
const PID_FILE = join(CONFIG_DIR, "embedder.pid");
const LOG_DIR = join(homedir(), ".local", "share", "veil");
const LOG_FILE = join(LOG_DIR, "embedder.log");

interface PidFileData {
	pid: number;
	port?: number;
	startedAt?: string;
	managed?: boolean;
}

function getExistingPid(): PidFileData | null {
	if (!existsSync(PID_FILE)) return null;
	try {
		const content = readFileSync(PID_FILE, "utf-8").trim();
		// Handle both old format (just PID) and new JSON format
		if (content.startsWith("{")) {
			const data = JSON.parse(content) as PidFileData;
			return Number.isNaN(data.pid) ? null : data;
		}
		const pid = parseInt(content, 10);
		return Number.isNaN(pid) ? null : { pid };
	} catch {
		return null;
	}
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killProcess(pid: number): boolean {
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!isProcessRunning(pid)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

async function checkPortInUse(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/status`, {
			signal: AbortSignal.timeout(1000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function setupFileLogging(): void {
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}
	const write = (level: string, args: unknown[]) => {
		const line = args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a)))
			.join(" ");
		try {
			appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${line}\n`);
		} catch {}
	};
	const originalLog = console.log.bind(console);
	const originalError = console.error.bind(console);
	console.log = (...args: unknown[]) => {
		write("info", args);
		originalLog(...args);
	};
	console.error = (...args: unknown[]) => {
		write("error", args);
		originalError(...args);
	};
}

function loadConfig(): EmbedderConfig {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}

	if (existsSync(CONFIG_FILE)) {
		try {
			const raw = readFileSync(CONFIG_FILE, "utf-8");
			return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
		} catch {
			return DEFAULT_CONFIG;
		}
	}

	return DEFAULT_CONFIG;
}

function saveConfig(config: EmbedderConfig): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function resolveCachePath(cachePath: string): string {
	const raw = cachePath.trim() || join(homedir(), ".cache", "veil", "models");
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return raw;
}

async function main() {
	// Tag process for identification
	process.title = "veil-embedder";

	setupFileLogging();
	const config = loadConfig();

	// Check for existing server instance
	console.log("Checking for existing embedder instances...");
	const existingPidData = getExistingPid();

	if (existingPidData) {
		const pidInfo = existingPidData.startedAt
			? `PID ${existingPidData.pid}, started ${existingPidData.startedAt}`
			: `PID ${existingPidData.pid}`;
		console.log(`  Found PID file: ${pidInfo}`);

		if (isProcessRunning(existingPidData.pid)) {
			console.log(`  Process ${existingPidData.pid} is running`);

			// Check if it's actually responding on the port
			if (await checkPortInUse(config.port)) {
				console.log(`  Server responding on port ${config.port}`);
				console.log(`Embedder server already running (PID ${existingPidData.pid}). Exiting.`);
				process.exit(0);
			}

			// Process exists but not responding - kill it
			console.log(`  Server NOT responding on port ${config.port} - stale process`);
			console.log(`Shutting down stale embedder process (PID ${existingPidData.pid})...`);
			killProcess(existingPidData.pid);
			if (!(await waitForProcessExit(existingPidData.pid))) {
				console.error(`Failed to stop process ${existingPidData.pid} gracefully. Force killing...`);
				try {
					process.kill(existingPidData.pid, "SIGKILL");
				} catch {}
				await waitForProcessExit(existingPidData.pid, 2000);
			}
			console.log(`  Process ${existingPidData.pid} terminated`);
		} else {
			console.log(`  Process ${existingPidData.pid} is NOT running (stale PID file)`);
			// Clean up stale PID file
			try {
				const { unlinkSync } = require("node:fs");
				unlinkSync(PID_FILE);
				console.log(`  Removed stale PID file`);
			} catch {}
		}
	} else {
		console.log("  No PID file found");
	}

	// Check if port is in use by something else
	if (await checkPortInUse(config.port)) {
		console.error(`Port ${config.port} is already in use by another process (not managed by veil).`);
		process.exit(1);
	}
	console.log(`  Port ${config.port} is available`);
	console.log("");

	const cacheDir = resolveCachePath(config.cachePath);
	configureCacheDir(cacheDir);
	if (!existsSync(cacheDir)) {
		mkdirSync(cacheDir, { recursive: true });
	}

	if (config.tier === "none") {
		console.log("Embedder disabled (tier=none). Exiting.");
		process.exit(0);
	}

	const spec = MODEL_REGISTRY[config.tier];
	if (!spec) {
		console.error(`Unknown model tier: ${config.tier}`);
		process.exit(1);
	}

	console.log(`Starting Veil Embedder Server...`);
	console.log(`  Model: ${spec.name} (${spec.size}, ${spec.ram} RAM)`);
	console.log(`  Port: ${config.port}`);
	console.log(`  Idle timeout: ${config.idleTimeoutMs / 1000 / 60} minutes`);

	let embedder: Embedder | null = null;
	let requestCount = 0;
	let lastActivity = Date.now();
	const startTime = Date.now();

	const resetIdleTimer = () => {
		lastActivity = Date.now();
	};

	const checkIdle = () => {
		if (Date.now() - lastActivity > config.idleTimeoutMs) {
			console.log("Idle timeout reached. Shutting down.");
			process.exit(0);
		}
	};

	const idleInterval = setInterval(checkIdle, 60000);

	const cleanup = () => {
		clearInterval(idleInterval);
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(PID_FILE);
		} catch {}
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	const fastify = Fastify({ logger: false });

	fastify.get<{ Reply: ServerStatus }>("/status", async () => {
		resetIdleTimer();
		return {
			ready: embedder !== null,
			model: embedder?.model ?? null,
			uptime: Date.now() - startTime,
			requestCount,
		};
	});

	fastify.post<{ Body: EmbedRequest; Reply: EmbedResponse }>("/embed", async (request, reply) => {
		resetIdleTimer();
		requestCount++;

		if (!embedder) {
			console.log("Loading model (first request)...");
			embedder = await createEmbedder(config.tier);
			if (!embedder) {
				reply.status(500);
				return { embeddings: [], model: "", dimensions: 0 };
			}
			console.log("Model loaded.");
		}

		const { texts } = request.body;
		if (!texts || !Array.isArray(texts) || texts.length === 0) {
			reply.status(400);
			return { embeddings: [], model: "", dimensions: 0, error: "texts must be a non-empty array" };
		}
		if (!texts.every((t) => typeof t === "string")) {
			reply.status(400);
			return { embeddings: [], model: "", dimensions: 0, error: "all texts must be strings" };
		}

		const embeddings = await embedder.embed(texts);
		return {
			embeddings: embeddings.map((e) => Array.from(e)),
			model: embedder.model.id,
			dimensions: embedder.dimensions,
		};
	});

	fastify.post("/unload", async () => {
		resetIdleTimer();
		if (embedder) {
			await embedder.unload();
			embedder = null;
			console.log("Model unloaded.");
		}
		return { ok: true };
	});

	fastify.post<{ Body: { tier: ModelTier } }>("/config", async (request) => {
		const { tier } = request.body;
		if (!MODEL_REGISTRY[tier] && tier !== "none") {
			return { error: "Unknown tier" };
		}

		config.tier = tier;
		saveConfig(config);

		if (embedder) {
			await embedder.unload();
			embedder = null;
		}

		return { ok: true, tier };
	});

	try {
		await fastify.listen({ port: config.port, host: "127.0.0.1" });
		console.log(`Server listening on http://127.0.0.1:${config.port}`);
		// Write PID file with metadata for identification
		const pidData = JSON.stringify({
			pid: process.pid,
			port: config.port,
			startedAt: new Date().toISOString(),
			managed: process.env.VEIL_EMBEDDER_MANAGED === "1",
		});
		writeFileSync(PID_FILE, pidData);
	} catch (err) {
		console.error("Failed to start server:", err);
		process.exit(1);
	}
}

main();
