import { describe, expect, it } from "vitest";
import { createEvictionFeedbackTracker, detectRerequest, REREQUEST_PATTERNS } from "./eviction-feedback.ts";

describe("detectRerequest", () => {
	it("returns null for unrelated messages", () => {
		expect(detectRerequest("how do I read a file?", 5)).toBeNull();
		expect(detectRerequest("let's implement this feature", 10)).toBeNull();
	});

	it("detects 'what did we decide'", () => {
		const result = detectRerequest("What did we decide about the auth flow?", 3);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("rerequest");
		expect(result?.turnNumber).toBe(3);
	});

	it("detects 'earlier you said'", () => {
		const result = detectRerequest("But earlier you said we should use OAuth.", 7);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("rerequest");
	});

	it("detects 'as I mentioned'", () => {
		const result = detectRerequest("As I mentioned before, the schema needs updating.", 12);
		expect(result).not.toBeNull();
	});

	it("detects 'we already discussed'", () => {
		const result = detectRerequest("We already discussed this approach.", 9);
		expect(result).not.toBeNull();
	});

	it("detects 'remember when'", () => {
		const result = detectRerequest("Remember when you suggested using PKCE?", 15);
		expect(result).not.toBeNull();
	});

	it("detects 'you said before'", () => {
		const result = detectRerequest("You said before this was the right approach.", 20);
		expect(result).not.toBeNull();
	});

	it("is case-insensitive", () => {
		expect(detectRerequest("WHAT DID WE DECIDE on this?", 1)).not.toBeNull();
		expect(detectRerequest("EARLIER YOU SAID something different.", 2)).not.toBeNull();
	});

	it("includes content and pattern in result", () => {
		const msg = "What did we decide about the database schema?";
		const result = detectRerequest(msg, 5);
		expect(result?.content).toBe(msg);
		expect(result?.pattern).toBe(REREQUEST_PATTERNS[0].toString());
	});
});

describe("createEvictionFeedbackTracker", () => {
	it("returns 0 adjustment with no feedback", () => {
		const tracker = createEvictionFeedbackTracker();
		expect(tracker.suggestThresholdAdjustment()).toBe(0);
	});

	it("returns empty array for recent feedback when empty", () => {
		const tracker = createEvictionFeedbackTracker();
		expect(tracker.getRecentFeedback()).toEqual([]);
	});

	it("records and retrieves feedback", () => {
		const tracker = createEvictionFeedbackTracker();
		const entry = detectRerequest("What did we decide about logging?", 5)!;
		tracker.record(entry);

		const recent = tracker.getRecentFeedback();
		expect(recent).toHaveLength(1);
		expect(recent[0].type).toBe("rerequest");
	});

	it("limits getRecentFeedback by limit param", () => {
		const tracker = createEvictionFeedbackTracker();
		for (let i = 1; i <= 15; i++) {
			const entry = detectRerequest("What did we decide?", i)!;
			tracker.record(entry);
		}
		expect(tracker.getRecentFeedback(5)).toHaveLength(5);
		expect(tracker.getRecentFeedback()).toHaveLength(10); // default limit
	});

	it("returns 0 for low rerequest rate", () => {
		const tracker = createEvictionFeedbackTracker();
		// 1 rerequest over 100 turns = 1% rate (below 5% threshold)
		tracker.record(detectRerequest("What did we decide?", 100)!);
		expect(tracker.suggestThresholdAdjustment()).toBe(0);
	});

	it("returns -1 for high rerequest rate", () => {
		const tracker = createEvictionFeedbackTracker();
		// 5 rerequests at turn 5 = 100% rate (above 20% threshold)
		for (let i = 1; i <= 5; i++) {
			tracker.record(detectRerequest("What did we decide?", i)!);
		}
		expect(tracker.suggestThresholdAdjustment()).toBe(-1);
	});

	it("returns negative value between 0 and -1 for medium rate", () => {
		const tracker = createEvictionFeedbackTracker();
		// 2 rerequests over 20 turns = 10% rate (between 5% and 20%)
		tracker.record(detectRerequest("What did we decide?", 10)!);
		tracker.record(detectRerequest("Earlier you said something", 20)!);
		const adj = tracker.suggestThresholdAdjustment();
		expect(adj).toBeLessThan(0);
		expect(adj).toBeGreaterThan(-1);
	});
});
