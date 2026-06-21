/**
 * IPC transport for parent-child communication
 */

import * as fs from "node:fs";
import * as net from "node:net";
import type { ChildMessage, IpcMessage, ParentMessage } from "./types.ts";

/**
 * Generate cross-platform IPC socket path
 */
export function ipcPath(sessionId: string, tag: string): string {
	const name = `veil-ipc-${sessionId}-${tag}`;
	return process.platform === "win32" ? `\\\\?\\pipe\\${name}` : `/tmp/${name}.sock`;
}

/**
 * Parse newline-delimited JSON message
 */
export function parseMessage(line: string): IpcMessage | null {
	try {
		const msg = JSON.parse(line);
		if (typeof msg.version !== "number" || typeof msg.type !== "string") {
			return null;
		}
		return msg as IpcMessage;
	} catch {
		return null;
	}
}

/**
 * Serialize message to newline-delimited JSON
 */
export function serializeMessage(msg: IpcMessage): string {
	return `${JSON.stringify(msg)}\n`;
}

export type MessageHandler<T extends IpcMessage> = (msg: T) => void;

/**
 * IPC Server - parent side
 */
export class IpcServer {
	private socketPath: string;
	private server: net.Server | null = null;
	private client: net.Socket | null = null;
	private buffer = "";
	private messageHandler: MessageHandler<ChildMessage> | null = null;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	async start(): Promise<void> {
		// Clean up stale socket if it exists
		if (fs.existsSync(this.socketPath)) {
			const isStale = await this.checkSocketStale();
			if (isStale) {
				fs.unlinkSync(this.socketPath);
			} else {
				throw new Error(`Socket already in use: ${this.socketPath}`);
			}
		}

		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => {
				this.client = socket;
				socket.on("data", (data) => this.handleData(data.toString()));
				socket.on("error", () => {
					this.client = null;
				});
				socket.on("close", () => {
					this.client = null;
				});
			});

			this.server.on("error", reject);
			this.server.listen(this.socketPath, resolve);
		});
	}

	private checkSocketStale(): Promise<boolean> {
		return new Promise((resolve) => {
			const client = net.createConnection(this.socketPath);
			const timeout = setTimeout(() => {
				client.destroy();
				resolve(true); // Timeout = stale
			}, 100);

			client.on("connect", () => {
				clearTimeout(timeout);
				client.destroy();
				resolve(false); // Connected = not stale
			});

			client.on("error", () => {
				clearTimeout(timeout);
				resolve(true); // Error = stale
			});
		});
	}

	isListening(): boolean {
		return this.server?.listening ?? false;
	}

	private handleData(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			const msg = parseMessage(line);
			if (msg && this.messageHandler) {
				this.messageHandler(msg as ChildMessage);
			}
		}
	}

	onMessage(handler: MessageHandler<ChildMessage>): void {
		this.messageHandler = handler;
	}

	send(msg: ParentMessage): boolean {
		if (!this.client) return false;
		this.client.write(serializeMessage(msg));
		return true;
	}

	async close(): Promise<void> {
		this.client?.destroy();
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => resolve());
			} else {
				resolve();
			}
		});
	}

	get connected(): boolean {
		return this.client !== null;
	}
}

/**
 * IPC Client - child side
 */
export class IpcClient {
	private socketPath: string;
	private socket: net.Socket | null = null;
	private buffer = "";
	private messageHandler: MessageHandler<ParentMessage> | null = null;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection(this.socketPath, () => {
				resolve();
			});

			this.socket.on("data", (data) => this.handleData(data.toString()));
			this.socket.on("error", reject);
		});
	}

	private handleData(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.trim()) continue;
			const msg = parseMessage(line);
			if (msg && this.messageHandler) {
				this.messageHandler(msg as ParentMessage);
			}
		}
	}

	onMessage(handler: MessageHandler<ParentMessage>): void {
		this.messageHandler = handler;
	}

	send(msg: ChildMessage): boolean {
		if (!this.socket) return false;
		this.socket.write(serializeMessage(msg));
		return true;
	}

	close(): void {
		this.socket?.destroy();
		this.socket = null;
	}

	get connected(): boolean {
		return this.socket !== null;
	}
}
