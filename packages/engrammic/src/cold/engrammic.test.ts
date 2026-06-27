/**
 * Tests for EngrammicColdStore using MockEngrammicServer.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ContextItem } from "../types.ts";
import { EngrammicColdStore, EngrammicUnavailableError } from "./engrammic.ts";
import { MockEngrammicServer } from "./engrammic-mock.ts";

function makeContextItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: `item-${Date.now()}`,
		content: "test content",
		contentHash: "hash123",
		createdAt: Date.now(),
		lastAccess: Date.now(),
		accessCount: 1,
		usedCount: 0,
		ignoredCount: 0,
		decayScore: 0.5,
		cognitiveWeight: 0.0,
		stability: 0.5,
		difficulty: 0.5,
		type: "episodic",
		tags: ["test"],
		pinned: false,
		source: "auto",
		...overrides,
	};
}

describe("EngrammicColdStore", () => {
	let mock: MockEngrammicServer;
	let store: EngrammicColdStore;

	beforeEach(() => {
		mock = new MockEngrammicServer();
		store = new EngrammicColdStore({
			mcpExecutor: mock.createExecutor(),
			projectId: "test-project",
			tagWithProject: true,
		});
	});

	afterEach(async () => {
		await store.close();
	});

	test("demote/fetch round-trip stores and retrieves item", async () => {
		const item = makeContextItem({
			content: "hello from cold storage",
			type: "episodic",
			tags: ["cold", "round-trip"],
		});

		const pointer = await store.demote(item);
		expect(typeof pointer).toBe("string");
		expect(pointer.length).toBeGreaterThan(0);

		const fetched = await store.fetch(pointer);
		expect(fetched).not.toBeNull();
		expect(fetched!.content).toBe(item.content);
		expect(fetched!.type).toBe("episodic");
		expect(fetched!.kgPointer).toBe(pointer);
	});

	test("demote fact with evidence uses learn, not remember", async () => {
		const learnCalls: string[] = [];
		const remembercalls: string[] = [];

		const trackingExecutor = async (tool: string, params: Record<string, unknown>) => {
			const toolName = tool.replace(/^mcp__\w+__/, "");
			if (toolName === "learn") learnCalls.push(toolName);
			if (toolName === "remember") remembercalls.push(toolName);
			return mock.createExecutor()(tool, params);
		};

		const factStore = new EngrammicColdStore({
			mcpExecutor: trackingExecutor,
			projectId: "test-project",
		});

		const factItem = makeContextItem({ type: "fact", content: "The sky is blue" });
		await factStore.demote(factItem);

		expect(learnCalls).toHaveLength(1);
		expect(remembercalls).toHaveLength(0);

		await factStore.close();
	});

	test("demote non-fact item uses remember, not learn", async () => {
		const learnCalls: string[] = [];
		const rememberCalls: string[] = [];

		const trackingExecutor = async (tool: string, params: Record<string, unknown>) => {
			const toolName = tool.replace(/^mcp__\w+__/, "");
			if (toolName === "learn") learnCalls.push(toolName);
			if (toolName === "remember") rememberCalls.push(toolName);
			return mock.createExecutor()(tool, params);
		};

		const episodicStore = new EngrammicColdStore({
			mcpExecutor: trackingExecutor,
			projectId: "test-project",
		});

		const episodicItem = makeContextItem({ type: "episodic", content: "I ran the tests" });
		await episodicStore.demote(episodicItem);

		expect(learnCalls).toHaveLength(0);
		expect(rememberCalls).toHaveLength(1);

		await episodicStore.close();
	});

	test("query with project scope adds project tag to filter", async () => {
		const recallParams: Record<string, unknown>[] = [];

		const trackingExecutor = async (tool: string, params: Record<string, unknown>) => {
			const toolName = tool.replace(/^mcp__\w+__/, "");
			if (toolName === "recall") recallParams.push(params);
			return mock.createExecutor()(tool, params);
		};

		const scopedStore = new EngrammicColdStore({
			mcpExecutor: trackingExecutor,
			projectId: "my-proj",
			tagWithProject: true,
		});

		await scopedStore.query!("some text", ["tag-a"], 10, { scope: "project" });

		expect(recallParams).toHaveLength(1);
		const tags = recallParams[0].tags as string[];
		expect(tags).toContain("project:my-proj");
		expect(tags).toContain("tag-a");

		await scopedStore.close();
	});

	test("query with global scope does not add project tag", async () => {
		const recallParams: Record<string, unknown>[] = [];

		const trackingExecutor = async (tool: string, params: Record<string, unknown>) => {
			const toolName = tool.replace(/^mcp__\w+__/, "");
			if (toolName === "recall") recallParams.push(params);
			return mock.createExecutor()(tool, params);
		};

		const scopedStore = new EngrammicColdStore({
			mcpExecutor: trackingExecutor,
			projectId: "my-proj",
			tagWithProject: true,
		});

		await scopedStore.query!("some text", [], 10, { scope: "global" });

		expect(recallParams).toHaveLength(1);
		const tags = recallParams[0].tags as string[] | undefined;
		// global scope: no project tag injected
		expect(tags == null || !tags.some((t) => t.startsWith("project:"))).toBe(true);

		await scopedStore.close();
	});

	test("circuit breaker opens after a failure", async () => {
		mock.setFailure(true, "network");

		// First call: real network error
		await expect(store.demote(makeContextItem())).rejects.toThrow("Network error");

		// Second call: circuit is open, no real call made
		await expect(store.demote(makeContextItem())).rejects.toThrow(EngrammicUnavailableError);
	});

	test("circuit breaker uses exponential backoff for rate limit errors", async () => {
		// Access private fields for test inspection via type cast
		const s = store as unknown as {
			available: boolean;
			checkInterval: number;
			lastCheck: number;
		};

		mock.setFailure(true, "rate_limit");
		const initialInterval = s.checkInterval; // 60_000

		// First failure: doubles the interval
		await expect(store.demote(makeContextItem())).rejects.toThrow("429");
		expect(s.available).toBe(false);
		expect(s.checkInterval).toBe(initialInterval * 2);

		// Force reset so next call actually hits the server
		s.lastCheck = 0;

		// Second failure: doubles again
		await expect(store.demote(makeContextItem())).rejects.toThrow("429");
		expect(s.checkInterval).toBe(initialInterval * 4);
	});

	test("conflicts() returns unresolved conflicts", async () => {
		mock.addConflict({
			edge_id: "edge-1",
			node_a: { node_id: "nodeA", content: "A says X", agent_id: "agent-1" },
			node_b: { node_id: "nodeB", content: "B says Y", agent_id: "agent-2" },
			resolution_status: "unresolved",
		});
		mock.addConflict({
			edge_id: "edge-2",
			node_a: { node_id: "nodeC", content: "C says Z", agent_id: "agent-1" },
			node_b: { node_id: "nodeD", content: "D says W", agent_id: "agent-3" },
			resolution_status: "resolved", // should be filtered out
		});

		const conflicts = await store.conflicts();

		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].conflictId).toBe("edge-1");
		expect(conflicts[0].nodeA.content).toBe("A says X");
		expect(conflicts[0].status).toBe("unresolved");
	});

	test("delete() calls forget and removes the item", async () => {
		const item = makeContextItem({ content: "to be forgotten" });
		const pointer = await store.demote(item);

		// Confirm it exists
		expect(await store.exists(pointer)).toBe(true);

		await store.delete(pointer);

		// After delete, exists should return false
		expect(await store.exists(pointer)).toBe(false);
	});

	test("exists() returns true for stored item", async () => {
		const pointer = await store.demote(makeContextItem());
		expect(await store.exists(pointer)).toBe(true);
	});

	test("exists() returns false for unknown pointer", async () => {
		expect(await store.exists("node_does_not_exist")).toBe(false);
	});

	test("count() returns node count from introspect", async () => {
		expect(await store.count()).toBe(0);

		await store.demote(makeContextItem({ id: "a" }));
		expect(await store.count()).toBe(1);

		await store.demote(makeContextItem({ id: "b" }));
		expect(await store.count()).toBe(2);
	});

	test("fetch returns null for unknown pointer", async () => {
		const result = await store.fetch("node_does_not_exist");
		expect(result).toBeNull();
	});

	test("demote tags item with projectId when tagWithProject is true", async () => {
		const rememberParams: Record<string, unknown>[] = [];

		const trackingExecutor = async (tool: string, params: Record<string, unknown>) => {
			const toolName = tool.replace(/^mcp__\w+__/, "");
			if (toolName === "remember") rememberParams.push(params);
			return mock.createExecutor()(tool, params);
		};

		const taggedStore = new EngrammicColdStore({
			mcpExecutor: trackingExecutor,
			projectId: "proj-xyz",
			tagWithProject: true,
		});

		await taggedStore.demote(makeContextItem({ tags: ["foo"] }));

		expect(rememberParams).toHaveLength(1);
		const tags = rememberParams[0].tags as string[];
		expect(tags).toContain("project:proj-xyz");
		expect(tags).toContain("foo");

		await taggedStore.close();
	});
});
