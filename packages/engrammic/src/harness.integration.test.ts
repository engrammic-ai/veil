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
					glob: false,
					listing: false,
					entityResolution: false,
				},
				demote: async () => {
					throw new Error("Cold storage unavailable");
				},
				fetch: async () => null,
				exists: async () => false,
				delete: async () => {},
				close: async () => {},
				count: async () => 0,
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

describe("onRecall hydration logging", () => {
	let tmpDir: string;
	let harness: VeilHarness;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "harness-recall-"));
		harness = new VeilHarness({ dbPath: join(tmpDir, "context.db"), sessionId: "test-session" });
	});

	afterEach(async () => {
		await harness.close();
		rmSync(tmpDir, { recursive: true });
	});

	test("logs hydration event when manifest item is recalled via veil_recall", async () => {
		// Store an item with tags that the "debug" trigger will surface
		const item = harness.getManager().remember("Debug info about the error", "episodic", ["debug", "error"]);

		// Build manifest via processUserMessage - "debugging" matches DEFAULT_TRIGGERS "debug" trigger
		const manifestResult = await harness.processUserMessage("I am debugging a crash");
		expect(manifestResult).not.toBeNull();
		expect(harness.wasInManifest(item.id)).toBe(true);

		// Recall the item via executeTool
		const result = await harness.executeTool("veil_recall", { tags: ["debug"], limit: 10 });
		expect(result.success).toBe(true);

		// Verify a hydration event was logged for this item
		const hydrations = harness.getManager().getCache().getRecentHydrations(10);
		expect(hydrations.length).toBeGreaterThan(0);
		const event = hydrations.find((h) => h.itemId === item.id);
		expect(event).toBeDefined();
		expect(event!.sessionId).toBe("test-session");
		expect(event!.userMessage).toBe("I am debugging a crash");
		expect(event!.latencyMs).toBeGreaterThanOrEqual(0);
		expect(event!.triggerIds).toContain("debug");
	});

	test("does not log hydration when manifest context is stale (older than 5 minutes)", async () => {
		// Store an item with tags that the "debug" trigger will surface
		const item = harness.getManager().remember("Debug info about a stale issue", "episodic", ["debug", "error"]);

		// Build manifest via processUserMessage
		await harness.processUserMessage("I am debugging a crash");
		expect(harness.wasInManifest(item.id)).toBe(true);

		// Directly overwrite currentManifest timestamp to simulate staleness (>5 minutes ago)
		// We access the private field via a cast to bypass TypeScript's access controls in tests.
		const STALE_MS = 5 * 60 * 1000 + 1000; // 5 minutes + 1 second
		(harness as unknown as { currentManifest: { timestamp: number } | null }).currentManifest!.timestamp =
			Date.now() - STALE_MS;

		// Recall the item — stale manifest should be discarded, no hydration logged
		const result = await harness.executeTool("veil_recall", { tags: ["debug"], limit: 10 });
		expect(result.success).toBe(true);

		const hydrations = harness.getManager().getCache().getRecentHydrations(10);
		const event = hydrations.find((h) => h.itemId === item.id);
		expect(event).toBeUndefined();
	});

	test("does not log hydration for items not in manifest", async () => {
		// Store a debug item and build manifest
		const manifestItem = harness.getManager().remember("Debug info", "episodic", ["debug", "error"]);
		await harness.processUserMessage("I am debugging a crash");
		expect(harness.wasInManifest(manifestItem.id)).toBe(true);

		// Store a non-manifest item (different tags, not matched by trigger)
		const otherItem = harness.getManager().remember("Unrelated fact", "fact", ["unrelated"]);

		// Recall the unrelated item by its tags — it was NOT in the manifest
		await harness.executeTool("veil_recall", { tags: ["unrelated"], limit: 10 });

		const hydrations = harness.getManager().getCache().getRecentHydrations(10);
		const event = hydrations.find((h) => h.itemId === otherItem.id);
		expect(event).toBeUndefined();
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

		const { lines } = await renderContextCommand(harness);
		const joined = lines.join("\n");

		// Shows hot items count and content preview
		expect(joined).toContain("1 items");
		expect(joined).toContain("Test content");

		await harness.close();
	});
});

describe("conversation eviction integration", () => {
	let tmpDir: string;
	let harness: VeilHarness;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "harness-conv-"));
		harness = new VeilHarness({
			dbPath: join(tmpDir, "context.db"),
			archivePath: join(tmpDir, "archive.db"),
			sessionId: "conv-test",
		});
		// Allow async init to settle
		await new Promise((r) => setTimeout(r, 20));
	});

	afterEach(async () => {
		await harness.close();
		rmSync(tmpDir, { recursive: true });
	});

	it("archiveTurn stores user and assistant turns", async () => {
		await harness.archiveTurn("user", "I want to refactor the auth module");
		await harness.archiveTurn("assistant", "I'll start by reading the current implementation");

		const archive = harness.getConversationArchive();
		expect(archive).toBeDefined();

		const turns = await archive!.getTurnRange("conv-test", 1, 10);
		expect(turns).toHaveLength(2);
		expect(turns[0]!.role).toBe("user");
		expect(turns[0]!.metaType).toBe("intent");
		expect(turns[1]!.role).toBe("assistant");
		expect(turns[1]!.metaType).toBe("action");
	});

	it("archiveTurn classifies turn types correctly", async () => {
		await harness.archiveTurn("user", "No, that's wrong — instead use the factory pattern");
		await harness.archiveTurn("assistant", "Done with the refactor, all tests pass");

		const archive = harness.getConversationArchive();
		const turns = await archive!.getTurnRange("conv-test", 1, 10);
		expect(turns[0]!.metaType).toBe("correction");
		expect(turns[1]!.metaType).toBe("status");
	});

	it("evictConversationTurns returns evicted turn IDs and produces stubs", async () => {
		// Archive enough turns to get past the protected window (12)
		for (let i = 0; i < 15; i++) {
			await harness.archiveTurn("assistant", `Completed step ${i} of the migration process`);
		}

		const evicted = await harness.evictConversationTurns(500);
		expect(evicted.length).toBeGreaterThan(0);

		const stubs = harness.getEvictionStubs();
		expect(stubs.length).toBeGreaterThan(0);
		expect(stubs[0]).toContain("summarized");
	});

	it("evictConversationTurns protects recent turns", async () => {
		// Archive only turns within the protected window
		for (let i = 0; i < 5; i++) {
			await harness.archiveTurn("assistant", `Recent action ${i}`);
		}

		const evicted = await harness.evictConversationTurns(1000);
		// All turns are within protected window — nothing should be evicted
		expect(evicted).toHaveLength(0);
	});

	it("detects rerequest feedback from user messages", async () => {
		await harness.archiveTurn("user", "What did we decide about the auth approach?");

		const tracker = harness.getEvictionFeedbackTracker();
		const recent = tracker.getRecentFeedback(5);
		expect(recent).toHaveLength(1);
		expect(recent[0]!.type).toBe("rerequest");
	});

	it("afterToolCall archives tool results when archive is configured", async () => {
		await harness.afterToolCall({ toolCall: { name: "Read" }, result: { isError: false } });

		const archive = harness.getConversationArchive();
		const turns = await archive!.getTurnRange("conv-test", 1, 10);
		expect(turns.some((t) => t.role === "tool" && t.content.includes("Read"))).toBe(true);
	});

	it("veil_turn_meta in beforeToolCall archives a meta turn", async () => {
		await harness.beforeToolCall({
			toolCall: { name: "veil_turn_meta" },
			args: { type: "decision", decision_summary: "Use SQLite for storage" },
		});

		const archive = harness.getConversationArchive();
		const turns = await archive!.getTurnRange("conv-test", 1, 10);
		expect(turns.some((t) => t.content.includes("type=decision"))).toBe(true);
	});

	it("getEvictionStubs returns empty when no evictions occurred", () => {
		expect(harness.getEvictionStubs()).toHaveLength(0);
	});
});
