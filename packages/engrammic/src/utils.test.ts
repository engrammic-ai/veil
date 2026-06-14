/**
 * Unit tests for utils.ts
 */

import { describe, expect, test } from "vitest";
import { contentHash, estimateTokens, smartTruncate } from "./utils.ts";

describe("estimateTokens", () => {
	test("empty string → 0", () => {
		expect(estimateTokens("")).toBe(0);
	});

	test('"hello" (5 chars) → 2 (ceil(5/4))', () => {
		expect(estimateTokens("hello")).toBe(2);
	});

	test("100 chars → 25", () => {
		const content = "a".repeat(100);
		expect(estimateTokens(content)).toBe(25);
	});

	test("4 chars → 1 (exact boundary)", () => {
		expect(estimateTokens("abcd")).toBe(1);
	});

	test("1 char → 1 (ceiling rounds up)", () => {
		expect(estimateTokens("x")).toBe(1);
	});
});

describe("smartTruncate", () => {
	test("content shorter than maxChars → unchanged", () => {
		const content = "short content";
		expect(smartTruncate(content, 100)).toBe(content);
	});

	test("content equal to maxChars → unchanged", () => {
		const content = "exactly twenty chars";
		expect(smartTruncate(content, content.length)).toBe(content);
	});

	test("maxChars <= 0 → empty string", () => {
		expect(smartTruncate("some content", 0)).toBe("");
		expect(smartTruncate("some content", -5)).toBe("");
	});

	test("content longer than maxChars → head + ellipsis + tail", () => {
		const content = "a".repeat(200);
		const result = smartTruncate(content, 100);
		expect(result).toContain("...");
		expect(result).toContain("chars truncated");
		expect(result.length).toBeLessThan(content.length);
	});

	test("ellipsis contains the truncated char count", () => {
		const content = "x".repeat(200);
		const maxChars = 100;
		const headSize = Math.floor(maxChars * 0.7); // 70
		const tailSize = Math.floor(maxChars * 0.25); // 25
		const truncated = content.length - headSize - tailSize; // 200 - 70 - 25 = 105

		const result = smartTruncate(content, maxChars);
		expect(result).toContain(`${truncated} chars truncated`);
	});

	test("head and tail segments are preserved", () => {
		const content = `HEAD${"m".repeat(100)}TAIL`;
		const result = smartTruncate(content, 20);
		// head size: floor(20 * 0.7) = 14, tail size: floor(20 * 0.25) = 5
		expect(result.startsWith("HEAD")).toBe(true);
		expect(result.endsWith("TAIL")).toBe(true);
	});
});

describe("contentHash", () => {
	test("returns full 64-char SHA-256 hex string", () => {
		const hash = contentHash("some content");
		expect(hash.length).toBe(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("same content → same hash", () => {
		const content = "deterministic input";
		expect(contentHash(content)).toBe(contentHash(content));
	});

	test("different content → different hash", () => {
		const hash1 = contentHash("content A");
		const hash2 = contentHash("content B");
		expect(hash1).not.toBe(hash2);
	});

	test("empty string produces a valid hash", () => {
		const hash = contentHash("");
		expect(hash.length).toBe(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});
