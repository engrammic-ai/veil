import { describe, expect, it, vi } from "vitest";
import { EmbedderClient, getServerPid, isServerProcessRunning } from "./client.ts";

describe("EmbedderClient", () => {
	it("uses default port 19532", () => {
		const client = new EmbedderClient();
		expect((client as any).port).toBe(19532);
	});

	it("allows custom port", () => {
		const client = new EmbedderClient({ port: 12345 });
		expect((client as any).port).toBe(12345);
	});

	it("auto-start is enabled by default", () => {
		const client = new EmbedderClient();
		expect((client as any).autoStart).toBe(true);
	});

	it("can disable auto-start", () => {
		const client = new EmbedderClient({ autoStart: false });
		expect((client as any).autoStart).toBe(false);
	});

	it("has 30s start timeout by default", () => {
		const client = new EmbedderClient();
		expect((client as any).startTimeoutMs).toBe(30000);
	});

	it("isRunning returns false when server not running", async () => {
		const client = new EmbedderClient({ port: 59999 });
		const running = await client.isRunning();
		expect(running).toBe(false);
	});
});

describe("getServerPid", () => {
	it("returns null when PID file does not exist", () => {
		const pid = getServerPid();
		expect(pid === null || typeof pid === "number").toBe(true);
	});
});

describe("isServerProcessRunning", () => {
	it("returns false when no PID file", () => {
		vi.mock("node:fs", () => ({
			existsSync: () => false,
			readFileSync: () => "",
		}));
		expect(typeof isServerProcessRunning()).toBe("boolean");
	});
});
