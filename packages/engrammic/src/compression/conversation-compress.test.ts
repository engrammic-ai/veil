import { describe, expect, it } from "vitest";
import { compressConversation } from "./conversation-compress.ts";

describe("compressConversation", () => {
	describe("turn splitting", () => {
		it("preserves short conversations", () => {
			const input = `Human: Hello
Assistant: Hi there
Human: How are you?
Assistant: I'm good!`;
			const result = compressConversation(input);
			expect(result).toBe(input);
		});

		it("compresses long conversations", () => {
			const turns = Array.from({ length: 20 }, (_, i) => `Human: Question ${i}\nAssistant: Answer ${i}`);
			const input = turns.join("\n");
			const result = compressConversation(input);
			expect(result).toContain("turns summarized");
			expect(result.length).toBeLessThan(input.length);
		});
	});

	describe("head and tail preservation", () => {
		it("preserves first 2 turns by default", () => {
			const turns = [
				"Human: First question",
				"Assistant: First answer",
				"Human: Second question",
				"Assistant: Second answer",
				"Human: Third question",
				"Assistant: Third answer",
				"Human: Fourth question",
				"Assistant: Fourth answer",
				"Human: Fifth question",
				"Assistant: Fifth answer",
				"Human: Sixth question",
				"Assistant: Sixth answer",
			];
			const input = turns.join("\n");
			const result = compressConversation(input);
			expect(result).toContain("First question");
			expect(result).toContain("First answer");
		});

		it("preserves last 3 turns by default", () => {
			const turns = Array.from({ length: 10 }, (_, i) => `Human: Question ${i}\nAssistant: Answer ${i}`);
			const input = turns.join("\n");
			const result = compressConversation(input);
			expect(result).toContain("Question 9");
			expect(result).toContain("Answer 9");
		});
	});

	describe("action extraction", () => {
		it("extracts key actions from middle turns", () => {
			const input = `Human: Start
Assistant: Begin
Human: Please fix the bug
Assistant: I fixed the bug in main.ts
Human: Now add a test
Assistant: I created the test file
Human: What about docs?
Assistant: I updated the README
Human: Great!
Assistant: Done!`;
			const result = compressConversation(input);
			expect(result).toContain("summarized");
			expect(result).toMatch(/fixed|created|updated/i);
		});
	});

	describe("speaker detection", () => {
		it("handles User/AI format", () => {
			const input = `User: Hello
AI: Hi
User: Bye
AI: Goodbye`;
			const result = compressConversation(input);
			expect(result).toContain("User:");
			expect(result).toContain("AI:");
		});

		it("handles Claude format", () => {
			const input = `Human: Hello
Claude: Hi there!`;
			const result = compressConversation(input);
			expect(result).toContain("Human:");
		});
	});

	describe("options", () => {
		it("respects custom headTurns", () => {
			// Each "Human:" and "Assistant:" is counted as a separate turn
			const turns = Array.from({ length: 10 }, (_, i) => `Human: Q${i}\nAssistant: A${i}`);
			const input = turns.join("\n");
			// headTurns: 4 keeps first 4 speaker turns = Q0, A0, Q1, A1
			const result = compressConversation(input, { headTurns: 4 });
			expect(result).toContain("Q0");
			expect(result).toContain("A0");
			expect(result).toContain("Q1");
			expect(result).toContain("A1");
		});

		it("respects custom tailTurns", () => {
			const turns = Array.from({ length: 10 }, (_, i) => `Human: Q${i}\nAssistant: A${i}`);
			const input = turns.join("\n");
			const result = compressConversation(input, { tailTurns: 1 });
			expect(result).toContain("A9");
			expect(result).not.toContain("A8");
		});

		it("handles tailTurns: 0 without destroying content", () => {
			const turns = Array.from({ length: 10 }, (_, i) => `Human: Q${i}\nAssistant: A${i}`);
			const input = turns.join("\n");
			const result = compressConversation(input, { headTurns: 2, tailTurns: 0 });
			// Should preserve head and summarize the rest, not drop everything
			expect(result).toContain("Q0");
			expect(result).toContain("summarized");
		});
	});

	describe("edge cases", () => {
		it("handles single turn", () => {
			const input = "Human: Just one message";
			const result = compressConversation(input);
			expect(result).toBe(input);
		});

		it("handles no speaker markers", () => {
			const input = "Some text without speakers\nMore text here";
			const result = compressConversation(input);
			expect(result).toBe(input);
		});
	});
});
