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
	setupFileLogging();
	const config = loadConfig();

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
		writeFileSync(PID_FILE, process.pid.toString());
	} catch (err) {
		console.error("Failed to start server:", err);
		process.exit(1);
	}
}

main();
