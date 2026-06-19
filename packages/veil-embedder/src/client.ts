/**
 * Client for talking to the veil-embedder server.
 * Auto-starts server if not running.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbedResponse, ServerStatus } from "./types.ts";
import { DEFAULT_CONFIG, type EmbedderConfig } from "./types.ts";

export const CONFIG_DIR = join(homedir(), ".veil");
export const CONFIG_FILE = join(CONFIG_DIR, "embedder.json");
export const PID_FILE = join(CONFIG_DIR, "embedder.pid");
export const LOCK_FILE = join(CONFIG_DIR, "embedder.lock");
export const LOG_DIR = join(homedir(), ".local", "share", "veil");
export const LOG_FILE = join(LOG_DIR, "embedder.log");
const DEFAULT_PORT = 19532;
const LOCK_TIMEOUT_MS = 10000; // 10 second lock timeout

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
				// Try to acquire lock to prevent multiple spawns
				if (!this.tryAcquireLock()) {
					// Another process is starting the server, wait for it
					const startTime = Date.now();
					while (Date.now() - startTime < this.startTimeoutMs) {
						await new Promise((r) => setTimeout(r, 500));
						if (await this.isRunning()) {
							return true;
						}
					}
					return false;
				}

				try {
					// Double-check after acquiring lock
					if (await this.isRunning()) {
						return true;
					}

					const serverPath = join(import.meta.dirname, "server.js");
					if (!existsSync(serverPath)) {
						console.error("veil-embedder server not found at", serverPath);
						return false;
					}

					const child = spawn("node", [serverPath], {
						detached: true,
						stdio: "ignore",
						env: { ...process.env, VEIL_EMBEDDER_MANAGED: "1" },
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
					this.releaseLock();
				}
			} finally {
				this.starting = null;
			}
		})();

		return this.starting;
	}

	private tryAcquireLock(): boolean {
		try {
			if (!existsSync(CONFIG_DIR)) {
				mkdirSync(CONFIG_DIR, { recursive: true });
			}

			// Check for stale lock
			if (existsSync(LOCK_FILE)) {
				try {
					const lockData = JSON.parse(readFileSync(LOCK_FILE, "utf-8"));
					const lockAge = Date.now() - lockData.timestamp;
					if (lockAge < LOCK_TIMEOUT_MS) {
						return false; // Lock is fresh, someone else is starting
					}
					// Lock is stale, remove it
				} catch {
					// Invalid lock file, remove it
				}
				unlinkSync(LOCK_FILE);
			}

			// Write our lock
			writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
			return true;
		} catch {
			return false;
		}
	}

	private releaseLock(): void {
		try {
			if (existsSync(LOCK_FILE)) {
				const lockData = JSON.parse(readFileSync(LOCK_FILE, "utf-8"));
				if (lockData.pid === process.pid) {
					unlinkSync(LOCK_FILE);
				}
			}
		} catch {}
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

export interface ServerPidInfo {
	pid: number;
	port?: number;
	startedAt?: string;
	managed?: boolean;
}

export function getServerPid(): number | null {
	const info = getServerPidInfo();
	return info?.pid ?? null;
}

export function getServerPidInfo(): ServerPidInfo | null {
	if (!existsSync(PID_FILE)) return null;
	try {
		const content = readFileSync(PID_FILE, "utf-8").trim();
		// Handle both old format (just PID) and new JSON format
		if (content.startsWith("{")) {
			const data = JSON.parse(content) as ServerPidInfo;
			return Number.isNaN(data.pid) ? null : data;
		}
		const pid = parseInt(content, 10);
		return Number.isNaN(pid) ? null : { pid };
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
