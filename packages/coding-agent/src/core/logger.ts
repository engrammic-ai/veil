/**
 * Simple file logger for veil sessions.
 * Writes to ~/.veil/logs/<session_id>.log
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let logPath: string | null = null;
let minLevel: LogLevel = "info";
let sessionId: string | null = null;

export function initLogger(sid: string, level: LogLevel = "info"): string {
	sessionId = sid;
	minLevel = level;

	const logsDir = join(homedir(), ".veil", "logs");
	if (!existsSync(logsDir)) {
		mkdirSync(logsDir, { recursive: true });
	}

	// ponytail: simple timestamp prefix, no fancy rotation
	const date = new Date().toISOString().slice(0, 10);
	logPath = join(logsDir, `${date}_${sid}.log`);

	log("info", "session", `Session started: ${sid}`);
	return logPath;
}

export function log(level: LogLevel, component: string, message: string, data?: unknown): void {
	if (!logPath) return;
	if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

	const ts = new Date().toISOString();
	const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : "";
	const line = `${ts} [${level.toUpperCase().padEnd(5)}] [${component}] ${message}${dataStr}\n`;

	try {
		appendFileSync(logPath, line);
	} catch {
		// ponytail: if logging fails, don't crash the session
	}
}

export function logError(component: string, err: unknown, context?: string): void {
	const msg = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	log("error", component, context ? `${context}: ${msg}` : msg, stack ? { stack } : undefined);
}

export function getLogPath(): string | null {
	return logPath;
}

export function getSessionId(): string | null {
	return sessionId;
}
