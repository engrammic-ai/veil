import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type ArchivedTurn, ConversationArchive } from "../conversation-archive.ts";
import { executeHistoryCommand, formatHistoryResults } from "./history.ts";

function makeTurn(overrides: Partial<ArchivedTurn> & { turnId: string; turnNumber: number }): ArchivedTurn {
	return {
		sessionId: "session-1",
		role: "user",
		content: "Hello world",
		...overrides,
	};
}

describe("executeHistoryCommand", () => {
	let testDir: string;
	let archive: ConversationArchive;

	beforeEach(async () => {
		testDir = join(process.cwd(), `.test-history-cmd-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		archive = new ConversationArchive(join(testDir, "archive.db"));
		await archive.init();
	});

	afterEach(() => {
		archive.close();
		rmSync(testDir, { recursive: true });
	});

	test("returns empty array when no turns exist", async () => {
		const results = await executeHistoryCommand({ archive });
		expect(results).toEqual([]);
	});

	test("returns all turns when no filter applied", async () => {
		await archive.archiveTurn(makeTurn({ turnId: "t1", turnNumber: 1, content: "First turn" }));
		await archive.archiveTurn(makeTurn({ turnId: "t2", turnNumber: 2, content: "Second turn" }));

		const results = await executeHistoryCommand({ archive });
		expect(results).toHaveLength(2);
	});

	test("filters by query string", async () => {
		await archive.archiveTurn(makeTurn({ turnId: "t1", turnNumber: 1, content: "Hello world" }));
		await archive.archiveTurn(makeTurn({ turnId: "t2", turnNumber: 2, content: "Goodbye world" }));
		await archive.archiveTurn(makeTurn({ turnId: "t3", turnNumber: 3, content: "Something else" }));

		const results = await executeHistoryCommand({ archive, query: "world" });
		expect(results).toHaveLength(2);
		const previews = results.map((r) => r.preview);
		expect(previews.some((p) => p.includes("Hello"))).toBe(true);
		expect(previews.some((p) => p.includes("Goodbye"))).toBe(true);
	});

	test("filters by meta_type", async () => {
		await archive.archiveTurn(makeTurn({ turnId: "t1", turnNumber: 1, content: "A decision", metaType: "decision" }));
		await archive.archiveTurn(
			makeTurn({ turnId: "t2", turnNumber: 2, content: "A correction", metaType: "correction" }),
		);
		await archive.archiveTurn(makeTurn({ turnId: "t3", turnNumber: 3, content: "Plain turn" }));

		const results = await executeHistoryCommand({ archive, type: "decision" });
		expect(results).toHaveLength(1);
		expect(results[0].type).toBe("decision");
	});

	test("filters by sessionId", async () => {
		await archive.archiveTurn(makeTurn({ turnId: "t1", turnNumber: 1, sessionId: "session-A", content: "A turn" }));
		await archive.archiveTurn(makeTurn({ turnId: "t2", turnNumber: 2, sessionId: "session-B", content: "B turn" }));

		const results = await executeHistoryCommand({ archive, sessionId: "session-A" });
		expect(results).toHaveLength(1);
		expect(results[0].turnId).toBe("t1");
	});

	test("maps turn fields to HistoryResult", async () => {
		await archive.archiveTurn(
			makeTurn({
				turnId: "t1",
				turnNumber: 5,
				role: "assistant",
				content: "A".repeat(200),
				metaType: "decision",
				decisionSummary: "Use approach X",
			}),
		);

		const results = await executeHistoryCommand({ archive });
		expect(results).toHaveLength(1);
		const r = results[0];
		expect(r.turnId).toBe("t1");
		expect(r.turnNumber).toBe(5);
		expect(r.role).toBe("assistant");
		expect(r.type).toBe("decision");
		expect(r.preview).toHaveLength(100);
		expect(r.decisionSummary).toBe("Use approach X");
		expect(r.evicted).toBe(false);
	});

	test("marks evicted turns", async () => {
		await archive.archiveTurn(makeTurn({ turnId: "t1", turnNumber: 1, content: "Evicted turn" }));
		await archive.markEvicted("t1", "summary stub");

		const results = await executeHistoryCommand({ archive });
		expect(results[0].evicted).toBe(true);
	});

	test("respects limit", async () => {
		for (let i = 1; i <= 5; i++) {
			await archive.archiveTurn(makeTurn({ turnId: `t${i}`, turnNumber: i, content: `Turn ${i}` }));
		}

		const results = await executeHistoryCommand({ archive, limit: 3 });
		expect(results).toHaveLength(3);
	});
});

describe("formatHistoryResults", () => {
	test("returns no-results message for empty array", () => {
		const output = formatHistoryResults([]);
		expect(output).toContain("(no results)");
	});

	test("formats turn with number and role", () => {
		const result = {
			turnId: "t1",
			turnNumber: 3,
			role: "assistant",
			preview: "Some content here",
			evicted: false,
		};
		const output = formatHistoryResults([result]);
		expect(output).toContain("#3");
		expect(output).toContain("assistant");
		expect(output).toContain("Some content here");
	});

	test("shows type marker when present", () => {
		const result = {
			turnId: "t1",
			turnNumber: 1,
			role: "user",
			type: "decision",
			preview: "We decided to use X",
			evicted: false,
		};
		const output = formatHistoryResults([result]);
		expect(output).toContain("[decision]");
	});

	test("shows evicted marker when evicted", () => {
		const result = {
			turnId: "t1",
			turnNumber: 1,
			role: "user",
			preview: "Evicted content",
			evicted: true,
		};
		const output = formatHistoryResults([result]);
		expect(output).toContain("[evicted]");
	});

	test("shows decision summary when present", () => {
		const result = {
			turnId: "t1",
			turnNumber: 1,
			role: "assistant",
			type: "decision",
			preview: "Content",
			decisionSummary: "Use approach X",
			evicted: false,
		};
		const output = formatHistoryResults([result]);
		expect(output).toContain("Decision: Use approach X");
	});
});
