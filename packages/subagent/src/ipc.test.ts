import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { IpcClient, IpcServer, ipcPath, parseMessage, serializeMessage } from "./ipc.ts";
import type { ChildMessage, ParentMessage } from "./types.ts";

describe("ipcPath", () => {
	it("returns Unix socket path on non-Windows", () => {
		const path = ipcPath("session123", "scout");
		if (process.platform !== "win32") {
			expect(path).toBe("/tmp/veil-ipc-session123-scout.sock");
		}
	});
});

describe("parseMessage", () => {
	it("parses valid JSON with version and type", () => {
		const msg = parseMessage('{"version":1,"type":"ready"}');
		expect(msg).toEqual({ version: 1, type: "ready" });
	});

	it("returns null for invalid JSON", () => {
		expect(parseMessage("not json")).toBeNull();
	});

	it("returns null if missing version", () => {
		expect(parseMessage('{"type":"ready"}')).toBeNull();
	});
});

describe("serializeMessage", () => {
	it("serializes with newline", () => {
		const result = serializeMessage({ version: 1, type: "ping" });
		expect(result).toBe('{"version":1,"type":"ping"}\n');
	});
});

describe("IpcServer and IpcClient", () => {
	const sockets: string[] = [];

	afterEach(async () => {
		for (const path of sockets) {
			try {
				fs.unlinkSync(path);
			} catch {}
		}
		sockets.length = 0;
	});

	it("exchanges messages between server and client", async () => {
		const socketPath = `/tmp/veil-ipc-test-${Date.now()}.sock`;
		sockets.push(socketPath);

		const server = new IpcServer(socketPath);
		const receivedByServer: ChildMessage[] = [];
		const receivedByClient: ParentMessage[] = [];

		server.onMessage((msg) => receivedByServer.push(msg));
		await server.start();

		const client = new IpcClient(socketPath);
		client.onMessage((msg) => receivedByClient.push(msg));
		await client.connect();

		// Client sends ready
		client.send({ version: 1, type: "ready" });
		await new Promise((r) => setTimeout(r, 50));

		expect(receivedByServer).toHaveLength(1);
		expect(receivedByServer[0].type).toBe("ready");

		// Server sends ping
		server.send({ version: 1, type: "ping" });
		await new Promise((r) => setTimeout(r, 50));

		expect(receivedByClient).toHaveLength(1);
		expect(receivedByClient[0].type).toBe("ping");

		client.close();
		await server.close();
	});
});
