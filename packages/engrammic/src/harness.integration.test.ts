// packages/engrammic/src/harness.integration.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { renderContextCommand } from "./commands/context.ts";
import { VeilHarness } from "./harness.ts";
import { ContextManager } from "./manager.ts";

function tmpDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "harness-ux-"));
	return join(dir, "context.db");
}

describe("VeilHarness integration", () => {
	let tmpDir: string;
	let harness: VeilHarness;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "harness-integration-"));
		harness = new VeilHarness({ dbPath: join(tmpDir, "context.db") });
	});

	afterEach(async () => {
		await harness.close();
		rmSync(tmpDir, { recursive: true });
	});

	describe("processAutoHydration", () => {
		test("detects and hydrates stubs in output", () => {
			const item = harness.getManager().remember("Full content here", "episodic", []);

			const output = `Looking at [EPISODE:${item.id}:summary], I see something interesting.`;
			const hydrated = harness.processAutoHydration(output);

			expect(hydrated).toContain("<veil-hydrated>");
			expect(hydrated).toContain("Full content here");
			expect(hydrated).toContain("</veil-hydrated>");
		});

		test("returns empty string when no stubs", () => {
			const output = "No stubs in this output.";
			const hydrated = harness.processAutoHydration(output);

			expect(hydrated).toBe("");
		});

		test("hydrates multiple stubs", () => {
			const item1 = harness.getManager().remember("Content one", "fact", []);
			const item2 = harness.getManager().remember("Content two", "procedural", []);

			const output = `See [FACT:${item1.id}:first] and [PROC:${item2.id}:second]`;
			const hydrated = harness.processAutoHydration(output);

			expect(hydrated).toContain("Content one");
			expect(hydrated).toContain("Content two");
		});
	});

	describe("checkpoint triggering", () => {
		test("tick returns true at checkpoint interval", () => {
			const manager = harness.getManager();

			for (let i = 1; i < 10; i++) {
				expect(manager.tick()).toBe(false);
			}
			expect(manager.tick()).toBe(true); // Turn 10

			for (let i = 1; i < 10; i++) {
				expect(manager.tick()).toBe(false);
			}
			expect(manager.tick()).toBe(true); // Turn 20
		});

		test("getTurnCount tracks correctly", () => {
			const manager = harness.getManager();

			expect(manager.getTurnCount()).toBe(0);
			manager.tick();
			expect(manager.getTurnCount()).toBe(1);
			manager.tick();
			manager.tick();
			expect(manager.getTurnCount()).toBe(3);
		});
	});

	describe("getContextSection", () => {
		test("returns empty context message when no items loaded", () => {
			const section = harness.getContextSection();

			expect(section).toContain("<veil-context>");
			expect(section).toContain("No items loaded");
			expect(section).toContain("</veil-context>");
		});

		test("includes loaded items with scores", () => {
			const item = harness.getManager().remember("Test content", "fact", ["test"]);
			harness.getManager().load([item.id]);

			const section = harness.getContextSection();

			expect(section).toContain("[FACT:");
			expect(section).toContain("score:");
			expect(section).toContain("1 item");
		});
	});

	describe("eviction integration", () => {
		test("circuit breaker protects against cold storage failures", async () => {
			// Create manager with failing cold storage
			const failingCold = {
				capabilities: {
					semantic: false,
					temporal: false,
					provenance: false,
				},
				demote: async () => {
					throw new Error("Cold storage unavailable");
				},
				fetch: async () => null,
				exists: async () => false,
				delete: async () => {},
				close: async () => {},
			};

			const manager = new ContextManager({ coldFailureThreshold: 2 }, failingCold);

			// Create items
			const _item = manager.remember("test", "episodic", ["tag"]);

			// Force eviction should not throw even with failing cold storage
			await expect(manager.checkEviction({ tags: [] })).resolves.not.toThrow();

			await manager.close();
		});
	});
});

describe("UX integration", () => {
	it("getUsage reflects loaded items", async () => {
		const harness = new VeilHarness({ dbPath: tmpDbPath() });

		// Initially empty
		let usage = harness.getUsage();
		expect(usage.hotItems).toBe(0);
		expect(usage.hotTokens).toBe(0);

		// Add and load items
		const item1 = harness.remember("First context item with some content", "fact", ["test"]);
		const item2 = harness.remember("Second context item with more content", "episodic", ["test"]);
		harness.load([item1.id, item2.id]);

		// Check updated usage
		usage = harness.getUsage();
		expect(usage.hotItems).toBe(2);
		expect(usage.hotTokens).toBeGreaterThan(0);
		expect(usage.percent).toBeGreaterThan(0);

		await harness.close();
	});

	it("renderContextCommand shows loaded items", async () => {
		const harness = new VeilHarness({ dbPath: tmpDbPath() });

		const item = harness.remember("Test content for context display", "fact", ["display"]);
		harness.load([item.id]);

		const { lines } = renderContextCommand(harness);
		const joined = lines.join("\n");

		expect(joined).toContain("Context Window");
		expect(joined).toContain("1 items");
		expect(joined).toContain("Test content");

		await harness.close();
	});
});
