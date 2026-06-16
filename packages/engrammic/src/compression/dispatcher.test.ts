import { describe, expect, it } from "vitest";
import { compress, compressSync } from "./dispatcher.ts";

describe("compress (async)", () => {
	it("handles empty string without division by zero", async () => {
		const result = await compress("");
		expect(result.compressed).toBe("");
		expect(result.ratio).toBe(1);
		expect(result.method).toBe("none");
	});

	it("detects and routes config content", async () => {
		const json = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item${i}` })) });
		const result = await compress(json);

		expect(result.contentType).toBe("config");
		expect(result.method).toBe("key-extract");
		expect(result.ratio).toBeLessThan(1);
	});

	it("detects and routes conversation content", async () => {
		const turns = Array.from({ length: 20 }, (_, i) => `Human: Question ${i}\nAssistant: Answer ${i}`);
		const conversation = turns.join("\n");
		const result = await compress(conversation);

		expect(result.contentType).toBe("conversation");
		expect(result.method).toBe("head-tail");
		expect(result.ratio).toBeLessThan(1);
	});

	it("returns original for prose (no compressor)", async () => {
		const prose = "This is just some plain text that does not match any special patterns.";
		const result = await compress(prose);

		expect(result.contentType).toBe("prose");
		expect(result.method).toBe("none");
		expect(result.ratio).toBe(1);
		expect(result.compressed).toBe(prose);
	});

	it("returns original if compression doesn't save enough", async () => {
		// Use prose content which has no compressor, so it always returns original
		const prose = "Short prose text.";
		const result = await compress(prose, { minSavingsRatio: 0.5 });

		expect(result.compressed).toBe(prose);
		expect(result.ratio).toBe(1);
		expect(result.method).toBe("none");
	});

	it("respects metadata for content type detection", async () => {
		const content = "const x = 1;";
		const result = await compress(content, { metadata: { filePath: "test.ts" } });

		expect(result.contentType).toBe("code");
	});
});

describe("compressSync", () => {
	it("handles empty string without division by zero", () => {
		const result = compressSync("");
		expect(result.compressed).toBe("");
		expect(result.ratio).toBe(1);
		expect(result.method).toBe("none");
	});

	it("compresses config synchronously", () => {
		const json = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => i) });
		const result = compressSync(json);

		expect(result.contentType).toBe("config");
		expect(result.method).toBe("key-extract");
	});

	it("compresses conversation synchronously", () => {
		const turns = Array.from({ length: 15 }, (_, i) => `Human: Q${i}\nAssistant: A${i}`);
		const result = compressSync(turns.join("\n"));

		expect(result.contentType).toBe("conversation");
		expect(result.method).toBe("head-tail");
	});

	it("returns original for code (needs async parser)", () => {
		const code = "function foo() { return 42; }";
		const result = compressSync(code, { metadata: { filePath: "test.js" } });

		expect(result.contentType).toBe("code");
		expect(result.method).toBe("none");
		expect(result.compressed).toBe(code);
	});

	it("returns original for prose", () => {
		const prose = "Just some text here.";
		const result = compressSync(prose);

		expect(result.contentType).toBe("prose");
		expect(result.method).toBe("none");
	});
});
