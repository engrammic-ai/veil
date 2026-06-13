/**
 * Unit tests for utils.ts
 */

import assert from "node:assert";
import { describe, test } from "node:test";
import { contentHash, estimateTokens, smartTruncate } from "./utils.ts";

describe("estimateTokens", () => {
	test("empty string → 0", () => {
		assert.strictEqual(estimateTokens(""), 0);
	});

	test('"hello" (5 chars) → 2 (ceil(5/4))', () => {
		assert.strictEqual(estimateTokens("hello"), 2);
	});

	test("100 chars → 25", () => {
		const content = "a".repeat(100);
		assert.strictEqual(estimateTokens(content), 25);
	});

	test("4 chars → 1 (exact boundary)", () => {
		assert.strictEqual(estimateTokens("abcd"), 1);
	});

	test("1 char → 1 (ceiling rounds up)", () => {
		assert.strictEqual(estimateTokens("x"), 1);
	});
});

describe("smartTruncate", () => {
	test("content shorter than maxChars → unchanged", () => {
		const content = "short content";
		assert.strictEqual(smartTruncate(content, 100), content);
	});

	test("content equal to maxChars → unchanged", () => {
		const content = "exactly twenty chars";
		assert.strictEqual(smartTruncate(content, content.length), content);
	});

	test("maxChars <= 0 → empty string", () => {
		assert.strictEqual(smartTruncate("some content", 0), "");
		assert.strictEqual(smartTruncate("some content", -5), "");
	});

	test("content longer than maxChars → head + ellipsis + tail", () => {
		const content = "a".repeat(200);
		const result = smartTruncate(content, 100);
		assert.ok(result.includes("..."));
		assert.ok(result.includes("chars truncated"));
		assert.ok(result.length < content.length);
	});

	test("ellipsis contains the truncated char count", () => {
		const content = "x".repeat(200);
		const maxChars = 100;
		const headSize = Math.floor(maxChars * 0.7); // 70
		const tailSize = Math.floor(maxChars * 0.25); // 25
		const truncated = content.length - headSize - tailSize; // 200 - 70 - 25 = 105

		const result = smartTruncate(content, maxChars);
		assert.ok(result.includes(`${truncated} chars truncated`));
	});

	test("head and tail segments are preserved", () => {
		const content = `HEAD${"m".repeat(100)}TAIL`;
		const result = smartTruncate(content, 20);
		// head size: floor(20 * 0.7) = 14, tail size: floor(20 * 0.25) = 5
		assert.ok(result.startsWith("HEAD"));
		assert.ok(result.endsWith("TAIL"));
	});
});

describe("contentHash", () => {
	test("returns 16-char hex string", () => {
		const hash = contentHash("some content");
		assert.strictEqual(hash.length, 16);
		assert.match(hash, /^[0-9a-f]{16}$/);
	});

	test("same content → same hash", () => {
		const content = "deterministic input";
		assert.strictEqual(contentHash(content), contentHash(content));
	});

	test("different content → different hash", () => {
		const hash1 = contentHash("content A");
		const hash2 = contentHash("content B");
		assert.notStrictEqual(hash1, hash2);
	});

	test("empty string produces a valid hash", () => {
		const hash = contentHash("");
		assert.strictEqual(hash.length, 16);
		assert.match(hash, /^[0-9a-f]{16}$/);
	});
});
