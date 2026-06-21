/**
 * IPC client for child-mode communication with parent process.
 * Simplified version of the subagent IPC client, bundled in engrammic
 * to avoid circular dependencies.
 */

import * as net from "node:net";

// Message types matching subagent protocol
export type ParentMessage =
	| { version: 1; type: "ping" }
	| { version: 1; type: "interrupt" }
	| { version: 1; type: "resume" }
	| { version: 1; type: "redirect"; task: string }
	| { version: 1; type: "abort"; reason?: string }
	| { version: 1; type: "respond"; requestId: string; answer: string }
	| { version: 1; type: "config"; key: string; value: unknown };

export type ChildMessage =
	| { version: 1; type: "pong" }
	| { version: 1; type: "ready" }
	| { version: 1; type: "escalate"; requestId: string; question: string }
	| { version: 1; type: "checkpoint"; turn: number; tokens: number; timestamp: number; lastTool?: string }
	| { version: 1; type: "progress"; message: string; percent?: number }
	| { version: 1; type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
	| { version: 1; type: "complete"; result: string }
	| { version: 1; type: "error"; message: string };

export type IpcMessage = ParentMessage | ChildMessage;

/**
 * Serialize message to newline-delimited JSON
 */
export function serializeMessage(msg: IpcMessage): string {
	return `${JSON.stringify(msg)}\n`;
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

export type MessageHandler<T extends IpcMessage> = (msg: T) => void;

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
