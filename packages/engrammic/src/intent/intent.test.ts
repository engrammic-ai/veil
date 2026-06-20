import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProjectIntentFile } from "./intent-types.ts";
import { generateIntentId, loadProjectIntent, saveProjectIntent } from "./project-intent.ts";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "veil-intent-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("loadProjectIntent", () => {
	test("returns null for missing file", async () => {
		const result = await loadProjectIntent(tmpDir);
		expect(result).toBeNull();
	});

	test("returns null on invalid JSON (graceful error)", async () => {
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(tmpDir, ".veil"), { recursive: true });
		await writeFile(join(tmpDir, ".veil", "intent.json"), "{ invalid json");
		const result = await loadProjectIntent(tmpDir);
		expect(result).toBeNull();
	});
});

describe("saveProjectIntent", () => {
	test("creates .veil directory if needed", async () => {
		const data: ProjectIntentFile = {
			current: null,
			intents: {},
			history: [],
		};
		await saveProjectIntent(tmpDir, data);
		const result = await loadProjectIntent(tmpDir);
		expect(result).not.toBeNull();
	});

	test("round-trip: save then load returns same data", async () => {
		const data: ProjectIntentFile = {
			current: "intent_abc12345",
			intents: {
				intent_abc12345: {
					id: "intent_abc12345",
					content: "Build the intent tracking system",
					status: "active",
					createdAt: 1000000,
					updatedAt: 1000001,
					phases: [
						{ id: "phase_1", content: "Create types", status: "completed" },
						{ id: "phase_2", content: "Write tests", status: "active" },
					],
				},
			},
			history: [],
		};
		await saveProjectIntent(tmpDir, data);
		const result = await loadProjectIntent(tmpDir);
		expect(result).toEqual(data);
	});
});

describe("history pruning", () => {
	test("keeps last 10 history entries on save", async () => {
		const history = Array.from({ length: 15 }, (_, i) => `intent_${i}`);
		const data: ProjectIntentFile = {
			current: null,
			intents: {},
			history,
		};
		await saveProjectIntent(tmpDir, data);
		const result = await loadProjectIntent(tmpDir);
		expect(result!.history).toHaveLength(10);
		expect(result!.history).toEqual(history.slice(-10));
	});

	test("keeps history with <= 10 entries unchanged", async () => {
		const history = ["intent_a", "intent_b", "intent_c"];
		const data: ProjectIntentFile = {
			current: null,
			intents: {},
			history,
		};
		await saveProjectIntent(tmpDir, data);
		const result = await loadProjectIntent(tmpDir);
		expect(result!.history).toEqual(history);
	});
});

describe("generateIntentId", () => {
	test("returns id with intent_ prefix", () => {
		const id = generateIntentId();
		expect(id).toMatch(/^intent_[A-Za-z0-9]{8}$/);
	});

	test("returns unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateIntentId()));
		expect(ids.size).toBe(100);
	});
});
