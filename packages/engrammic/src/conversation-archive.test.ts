import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type ArchivedTurn, ConversationArchive } from "./conversation-archive.ts";

function makeTurn(overrides: Partial<ArchivedTurn> = {}): ArchivedTurn {
	return {
		turnId: `turn-${Date.now()}-${Math.random()}`,
		sessionId: "session-1",
		turnNumber: 1,
		role: "user",
		content: "Hello world",
		...overrides,
	};
}

describe("ConversationArchive", () => {
	let testDir: string;
	let archive: ConversationArchive;

	beforeEach(async () => {
		testDir = join(process.cwd(), `.test-conv-archive-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		archive = new ConversationArchive(join(testDir, "archive.db"));
		await archive.init();
	});

	afterEach(() => {
		archive.close();
		rmSync(testDir, { recursive: true });
	});

	test("init creates table", async () => {
		// If init succeeded without throwing, the table exists.
		// Verify by archiving a turn (would fail if table missing).
		const turn = makeTurn();
		await expect(archive.archiveTurn(turn)).resolves.toBeUndefined();
	});

	test("archiveTurn stores a turn", async () => {
		const turn = makeTurn({ turnId: "t1", sessionId: "s1", turnNumber: 1, role: "assistant", content: "Hi" });
		await archive.archiveTurn(turn);
		const result = await archive.getTurn("t1");
		expect(result).not.toBeNull();
		expect(result?.sessionId).toBe("s1");
		expect(result?.role).toBe("assistant");
		expect(result?.content).toBe("Hi");
	});

	test("getTurn returns null for unknown id", async () => {
		const result = await archive.getTurn("nonexistent");
		expect(result).toBeNull();
	});

	test("archiveTurn round-trips optional fields", async () => {
		const turn = makeTurn({
			turnId: "t2",
			metaType: "decision",
			intentId: "intent-42",
			decisionSummary: "Use approach X",
		});
		await archive.archiveTurn(turn);
		const result = await archive.getTurn("t2");
		expect(result?.metaType).toBe("decision");
		expect(result?.intentId).toBe("intent-42");
		expect(result?.decisionSummary).toBe("Use approach X");
	});
});
