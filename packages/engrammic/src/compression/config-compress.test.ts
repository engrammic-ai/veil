import { describe, expect, it } from "vitest";
import { compressConfig } from "./config-compress.ts";

describe("compressConfig", () => {
	describe("JSON compression", () => {
		it("preserves small objects", () => {
			const input = '{"name": "test", "version": "1.0"}';
			const result = compressConfig(input);
			expect(result).toContain("name:");
			expect(result).toContain("version:");
		});

		it("truncates long string values", () => {
			const longValue = "a".repeat(200);
			const input = JSON.stringify({ description: longValue });
			const result = compressConfig(input);
			expect(result).toContain("...");
			expect(result.length).toBeLessThan(input.length);
		});

		it("summarizes large arrays", () => {
			const input = JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => i) });
			const result = compressConfig(input);
			expect(result).toContain("[100 items]");
			expect(result).toContain("more");
		});

		it("preserves key fields (name, id, type, etc.)", () => {
			const input = JSON.stringify({
				id: "123",
				name: "test",
				type: "module",
				randomField: "ignored in priority",
			});
			const result = compressConfig(input);
			expect(result).toContain("id:");
			expect(result).toContain("name:");
			expect(result).toContain("type:");
		});

		it("limits depth", () => {
			const deep = { a: { b: { c: { d: { e: { f: "deep" } } } } } };
			const result = compressConfig(JSON.stringify(deep), { maxDepth: 3 });
			expect(result).toContain("[...]");
		});
	});

	describe("YAML-like compression", () => {
		it("preserves short YAML", () => {
			const input = "name: test\nversion: 1.0";
			const result = compressConfig(input);
			expect(result).toContain("name:");
			expect(result).toContain("version:");
		});

		it("summarizes long YAML", () => {
			const lines = Array.from({ length: 50 }, (_, i) => `key${i}: value${i}`);
			const input = lines.join("\n");
			const result = compressConfig(input);
			expect(result).toContain("more lines");
			expect(result.split("\n").length).toBeLessThan(50);
		});
	});

	describe("edge cases", () => {
		it("handles empty object", () => {
			expect(compressConfig("{}")).toBe("{}");
		});

		it("handles empty array", () => {
			expect(compressConfig("[]")).toBe("[]");
		});

		it("handles null", () => {
			expect(compressConfig("null")).toBe("null");
		});

		it("handles invalid JSON gracefully", () => {
			const invalid = "{ broken json";
			const result = compressConfig(invalid);
			expect(result).toBe(invalid);
		});
	});
});
