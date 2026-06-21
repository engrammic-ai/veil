import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentContext, mergeSubagentContext } from "./context.ts";

describe("createSubagentContext", () => {
	const testDbPath = `/tmp/veil-ctx-test-${Date.now()}.db`;

	afterEach(() => {
		try {
			fs.rmSync(testDbPath, { force: true });
			fs.rmSync(`${testDbPath}.children`, { recursive: true, force: true });
		} catch {}
	});

	it("creates context with correct paths", () => {
		const ctx = createSubagentContext(testDbPath, "parent-session", {
			tag: "scout",
		});

		expect(ctx.tag).toBe("scout");
		expect(ctx.parentDbPath).toBe(testDbPath);
		expect(ctx.childDbPath).toContain(".children/");
		expect(ctx.childDbPath).toContain("scout");
		expect(ctx.sessionId).toContain("parent-session");
		expect(ctx.sessionId).toContain("scout");
		expect(ctx.ipcPath).toContain("scout");
	});

	it("creates children directory", () => {
		createSubagentContext(testDbPath, "parent", { tag: "test" });
		expect(fs.existsSync(`${testDbPath}.children`)).toBe(true);
	});

	it("cleanup removes child DB files", async () => {
		const ctx = createSubagentContext(testDbPath, "parent", { tag: "test" });

		// Create dummy file
		fs.writeFileSync(ctx.childDbPath, "test");
		expect(fs.existsSync(ctx.childDbPath)).toBe(true);

		await ctx.cleanup();
		expect(fs.existsSync(ctx.childDbPath)).toBe(false);
	});
});

describe("mergeSubagentContext", () => {
	it("returns zeros when child DB does not exist (with mock harness)", async () => {
		const ctx = createSubagentContext("/tmp/nonexistent.db", "parent", { tag: "test" });

		// Create a minimal mock harness that just calls importFromDb
		const mockHarness = {
			async importFromDb(_childDbPath: string, _options: { tag?: string; sessionId?: string }) {
				// Since the child DB doesn't exist, importFromDb should return zeros
				return { imported: 0, skipped: 0 };
			},
		};

		const result = await mergeSubagentContext(mockHarness as any, ctx);
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.childSession).toContain("test");
	});
});
