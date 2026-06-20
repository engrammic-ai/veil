import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionIntentManager } from "./session-intent.ts";

let manager: SessionIntentManager;
let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "veil-test-"));
	manager = new SessionIntentManager({ sessionId: "test-session", projectRoot: tmpDir });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("createPrimary", () => {
	test("creates primary intent with correct defaults", () => {
		const intent = manager.createPrimary("Build the thing");
		expect(intent.type).toBe("primary");
		expect(intent.content).toBe("Build the thing");
		expect(intent.status).toBe("active");
		expect(intent.confidence).toBe("inferred");
		expect(intent.source).toBe("user");
		expect(intent.sessionId).toBe("test-session");
		expect(intent.id).toMatch(/^intent_/);
		expect(typeof intent.createdAt).toBe("number");
	});

	test("respects confidence and source options", () => {
		const intent = manager.createPrimary("Do X", { confidence: "explicit", source: "plan" });
		expect(intent.confidence).toBe("explicit");
		expect(intent.source).toBe("plan");
	});
});

describe("createSub", () => {
	test("creates sub-intent linked to parent", () => {
		const primary = manager.createPrimary("Do X");
		const sub = manager.createSub("Step 1", primary.id);
		expect(sub.type).toBe("sub");
		expect(sub.parent).toBe(primary.id);
		expect(sub.sessionId).toBe("test-session");
	});

	test("active sub-intent becomes current", () => {
		const primary = manager.createPrimary("Do X");
		const sub = manager.createSub("Step 1", primary.id, { status: "active" });
		expect(sub.current).toBe(true);
		expect(manager.getCurrent()?.id).toBe(sub.id);
	});

	test("new active sub clears previous current", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id, { status: "active" });
		expect(sub1.current).toBe(true);

		const sub2 = manager.createSub("Step 2", primary.id, { status: "active" });
		expect(sub2.current).toBe(true);
		expect(manager.getCurrent()?.id).toBe(sub2.id);

		// sub1 should no longer be current
		const all = manager.getAll();
		const updatedSub1 = all.find((i) => i.id === sub1.id);
		expect(updatedSub1?.current).toBeFalsy();
	});

	test("pending sub-intent does not become current", () => {
		const primary = manager.createPrimary("Do X");
		manager.createSub("Step 1", primary.id, { status: "pending" });
		expect(manager.getCurrent()).toBeNull();
	});

	test("default status does not become current", () => {
		const primary = manager.createPrimary("Do X");
		manager.createSub("Step 1", primary.id);
		expect(manager.getCurrent()).toBeNull();
	});
});

describe("getPrimary", () => {
	test("returns null with no primary", () => {
		expect(manager.getPrimary()).toBeNull();
	});

	test("returns the primary intent", () => {
		const primary = manager.createPrimary("Do X");
		expect(manager.getPrimary()?.id).toBe(primary.id);
	});
});

describe("getCurrent", () => {
	test("returns null when no current", () => {
		expect(manager.getCurrent()).toBeNull();
	});
});

describe("getSubIntents", () => {
	test("returns empty array for unknown parent", () => {
		expect(manager.getSubIntents("nonexistent")).toEqual([]);
	});

	test("returns sub-intents for a parent", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id);
		const sub2 = manager.createSub("Step 2", primary.id);
		const subs = manager.getSubIntents(primary.id);
		expect(subs).toHaveLength(2);
		expect(subs.map((s) => s.id)).toContain(sub1.id);
		expect(subs.map((s) => s.id)).toContain(sub2.id);
	});
});

describe("complete", () => {
	test("marks intent as completed", () => {
		const primary = manager.createPrimary("Do X");
		const sub = manager.createSub("Step 1", primary.id, { status: "active" });
		manager.complete(sub.id);
		const all = manager.getAll();
		const updated = all.find((i) => i.id === sub.id)!;
		expect(updated.status).toBe("completed");
		expect(updated.completedAt).toBeDefined();
	});

	test("complete current advances to next pending sub-intent", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id, { status: "active" });
		const sub2 = manager.createSub("Step 2", primary.id, { status: "pending" });

		manager.complete(sub1.id);

		expect(manager.getCurrent()?.id).toBe(sub2.id);
		const all = manager.getAll();
		const updatedSub2 = all.find((i) => i.id === sub2.id)!;
		expect(updatedSub2.status).toBe("active");
		expect(updatedSub2.current).toBe(true);
	});

	test("complete with no pending clears current", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id, { status: "active" });

		manager.complete(sub1.id);

		expect(manager.getCurrent()).toBeNull();
	});

	test("complete advances to earliest pending by createdAt", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id, { status: "active" });
		const sub2 = manager.createSub("Step 2", primary.id, { status: "pending" });
		const _sub3 = manager.createSub("Step 3", primary.id, { status: "pending" });

		manager.complete(sub1.id);

		// sub2 was created before sub3, so it should be next
		expect(manager.getCurrent()?.id).toBe(sub2.id);
	});
});

describe("abandon", () => {
	test("marks intent as abandoned", () => {
		const primary = manager.createPrimary("Do X");
		const sub = manager.createSub("Step 1", primary.id, { status: "active" });
		manager.abandon(sub.id);
		const all = manager.getAll();
		const updated = all.find((i) => i.id === sub.id)!;
		expect(updated.status).toBe("abandoned");
	});

	test("abandoning current clears current pointer", () => {
		const primary = manager.createPrimary("Do X");
		const sub = manager.createSub("Step 1", primary.id, { status: "active" });
		expect(manager.getCurrent()?.id).toBe(sub.id);

		manager.abandon(sub.id);
		expect(manager.getCurrent()).toBeNull();
	});

	test("abandoning non-current does not affect current", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id, { status: "active" });
		const sub2 = manager.createSub("Step 2", primary.id, { status: "pending" });

		manager.abandon(sub2.id);
		expect(manager.getCurrent()?.id).toBe(sub1.id);
	});
});

describe("focus", () => {
	test("sets current to specified sub-intent", () => {
		const primary = manager.createPrimary("Do X");
		const sub1 = manager.createSub("Step 1", primary.id, { status: "active" });
		const sub2 = manager.createSub("Step 2", primary.id, { status: "pending" });

		manager.focus(sub2.id);
		expect(manager.getCurrent()?.id).toBe(sub2.id);

		const all = manager.getAll();
		const updatedSub1 = all.find((i) => i.id === sub1.id)!;
		expect(updatedSub1.current).toBeFalsy();
	});

	test("focus throws for unknown id", () => {
		expect(() => manager.focus("nonexistent")).toThrow();
	});
});

describe("getAll and clear", () => {
	test("getAll returns all stored intents", () => {
		const primary = manager.createPrimary("Do X");
		manager.createSub("Step 1", primary.id);
		expect(manager.getAll()).toHaveLength(2);
	});

	test("clear removes all intents", async () => {
		const primary = manager.createPrimary("Do X");
		manager.createSub("Step 1", primary.id);
		await manager.clear();
		expect(manager.getAll()).toHaveLength(0);
		expect(manager.getPrimary()).toBeNull();
		expect(manager.getCurrent()).toBeNull();
	});
});

describe("persistence", () => {
	test("load returns empty manager for new session", async () => {
		const m = await SessionIntentManager.load({ sessionId: "new-session", projectRoot: tmpDir });
		expect(m.getAll()).toHaveLength(0);
		expect(m.getPrimary()).toBeNull();
	});

	test("save creates directory and file", async () => {
		manager.createPrimary("Save test");
		await manager.save();
		const filePath = join(tmpDir, ".veil", "session-intents", "test-session.json");
		expect(existsSync(filePath)).toBe(true);
	});

	test("round-trip: create intents, save, load returns same state", async () => {
		const primary = manager.createPrimary("Round trip");
		manager.createSub("Sub step", primary.id, { status: "active" });
		await manager.save();

		const loaded = await SessionIntentManager.load({ sessionId: "test-session", projectRoot: tmpDir });
		expect(loaded.getAll()).toHaveLength(2);
		expect(loaded.getPrimary()?.content).toBe("Round trip");
		expect(loaded.getCurrent()?.content).toBe("Sub step");
	});

	test("mutations auto-save (file updated after createSub)", async () => {
		const primary = manager.createPrimary("Auto save test");
		// wait for fire-and-forget save to complete
		await new Promise((r) => setTimeout(r, 50));
		const filePath = join(tmpDir, ".veil", "session-intents", "test-session.json");
		expect(existsSync(filePath)).toBe(true);

		manager.createSub("Sub", primary.id, { status: "active" });
		await new Promise((r) => setTimeout(r, 50));
		const raw = JSON.parse(await readFile(filePath, "utf-8"));
		expect(Object.keys(raw.intents)).toHaveLength(2);
	});

	test("handles corrupt JSON gracefully", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const dir = join(tmpDir, ".veil", "session-intents");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "corrupt.json"), "not valid json");

		const m = await SessionIntentManager.load({ sessionId: "corrupt", projectRoot: tmpDir });
		expect(m.getAll()).toHaveLength(0);
	});

	test("saved file includes sessionId, createdAt, updatedAt", async () => {
		manager.createPrimary("Check fields");
		await manager.save();

		const filePath = join(tmpDir, ".veil", "session-intents", "test-session.json");
		const raw = JSON.parse(await readFile(filePath, "utf-8"));
		expect(raw.sessionId).toBe("test-session");
		expect(typeof raw.createdAt).toBe("number");
		expect(typeof raw.updatedAt).toBe("number");
	});
});
