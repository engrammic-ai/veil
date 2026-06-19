/**
 * Client for talking to the veil-embedder server.
 * Auto-starts server if not running.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbedResponse, ServerStatus } from "./types.ts";
import { DEFAULT_CONFIG, type EmbedderConfig } from "./types.ts";

export const CONFIG_DIR = join(homedir(), ".config", "veil");
export const CONFIG_FILE = join(CONFIG_DIR, "embedder.json");
export const PID_FILE = join(CONFIG_DIR, "embedder.pid");
export const LOG_DIR = join(homedir(), ".local", "share", "veil");
export const LOG_FILE = join(LOG_DIR, "embedder.log");
const DEFAULT_PORT = 19532;

export function loadConfig(): EmbedderConfig {
	if (existsSync(CONFIG_FILE)) {
		try {
			return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: EmbedderConfig): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export interface EmbedderClientConfig {
	port?: number;
	autoStart?: boolean;
	startTimeoutMs?: number;
}

export class EmbedderClient {
	private port: number;
	private autoStart: boolean;
	private startTimeoutMs: number;
	private baseUrl: string;
	private starting: Promise<boolean> | null = null;

	constructor(config: EmbedderClientConfig = {}) {
		this.port = config.port ?? DEFAULT_PORT;
		this.autoStart = config.autoStart ?? true;
		this.startTimeoutMs = config.startTimeoutMs ?? 30000;
		this.baseUrl = `http://127.0.0.1:${this.port}`;
	}

	async isRunning(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/status`, {
				signal: AbortSignal.timeout(1000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	async start(): Promise<boolean> {
		if (await this.isRunning()) {
			return true;
		}

		if (this.starting) {
			return this.starting;
		}

		this.starting = (async () => {
			try {
				const serverPath = join(import.meta.dirname, "server.js");
				if (!existsSync(serverPath)) {
					console.error("veil-embedder server not found at", serverPath);
					return false;
				}

				const child = spawn("node", [serverPath], {
					detached: true,
					stdio: "ignore",
				});

				child.unref();

				const startTime = Date.now();
				while (Date.now() - startTime < this.startTimeoutMs) {
					await new Promise((r) => setTimeout(r, 500));
					if (await this.isRunning()) {
						return true;
					}
				}

				return false;
			} finally {
				this.starting = null;
			}
		})();

		return this.starting;
	}

	async ensureRunning(): Promise<boolean> {
		if (await this.isRunning()) return true;
		if (!this.autoStart) return false;
		return this.start();
	}

	async status(): Promise<ServerStatus | null> {
		try {
			const res = await fetch(`${this.baseUrl}/status`);
			if (!res.ok) return null;
			return (await res.json()) as ServerStatus;
		} catch {
			return null;
		}
	}

	async embed(texts: string[]): Promise<Float32Array[] | null> {
		if (!(await this.ensureRunning())) {
			return null;
		}

		try {
			const res = await fetch(`${this.baseUrl}/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ texts }),
			});

			if (!res.ok) return null;

			const data = (await res.json()) as EmbedResponse;
			return data.embeddings.map((e) => new Float32Array(e));
		} catch {
			return null;
		}
	}

	async embedOne(text: string): Promise<Float32Array | null> {
		const result = await this.embed([text]);
		return result?.[0] ?? null;
	}

	async unload(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/unload`, { method: "POST" });
			return res.ok;
		} catch {
			return false;
		}
	}

	async getDimensions(): Promise<number | null> {
		const status = await this.status();
		return status?.model?.dimensions ?? null;
	}
}

export function getServerPid(): number | null {
	if (!existsSync(PID_FILE)) return null;
	try {
		const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
		return Number.isNaN(pid) ? null : pid;
	} catch {
		return null;
	}
}

export function isServerProcessRunning(): boolean {
	const pid = getServerPid();
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
