import { describe, expect, it } from "vitest";
import { detectContentType } from "./content-type.ts";

describe("detectContentType", () => {
	describe("file extension detection", () => {
		it("detects TypeScript as code", () => {
			expect(detectContentType("const x = 1;", { filePath: "foo.ts" })).toBe("code");
			expect(detectContentType("const x = 1;", { filePath: "foo.tsx" })).toBe("code");
		});

		it("detects JavaScript as code", () => {
			expect(detectContentType("const x = 1;", { filePath: "foo.js" })).toBe("code");
			expect(detectContentType("const x = 1;", { filePath: "foo.mjs" })).toBe("code");
		});

		it("detects Python as code", () => {
			expect(detectContentType("def foo():", { filePath: "foo.py" })).toBe("code");
		});

		it("detects Go as code", () => {
			expect(detectContentType("func main() {}", { filePath: "main.go" })).toBe("code");
		});

		it("detects JSON as config", () => {
			expect(detectContentType("{}", { filePath: "package.json" })).toBe("config");
		});

		it("detects YAML as config", () => {
			expect(detectContentType("key: value", { filePath: "config.yaml" })).toBe("config");
			expect(detectContentType("key: value", { filePath: "config.yml" })).toBe("config");
		});

		it("detects TOML as config", () => {
			expect(detectContentType("[section]", { filePath: "config.toml" })).toBe("config");
		});

		it("detects Markdown as prose", () => {
			expect(detectContentType("# Heading", { filePath: "README.md" })).toBe("prose");
		});
	});

	describe("content pattern detection", () => {
		it("detects JSON by structure", () => {
			expect(detectContentType('{"key": "value"}')).toBe("config");
			expect(detectContentType("[1, 2, 3]")).toBe("config");
		});

		it("detects YAML by structure", () => {
			expect(detectContentType("name: test\nversion: 1.0")).toBe("config");
		});

		it("detects code by patterns", () => {
			const tsCode = `
import { foo } from 'bar';
export function test() {
  return 42;
}`;
			expect(detectContentType(tsCode)).toBe("code");
		});

		it("detects conversation patterns", () => {
			expect(detectContentType("Human: Hello\nAssistant: Hi there")).toBe("conversation");
			expect(detectContentType("User: What is 2+2?\nAI: 4")).toBe("conversation");
		});

		it("defaults to prose for plain text", () => {
			expect(detectContentType("This is just some plain text without any special markers.")).toBe("prose");
		});
	});

	describe("tag-based detection", () => {
		it("detects conversation from tags", () => {
			expect(detectContentType("random text", { tags: ["conversation"] })).toBe("conversation");
		});
	});

	describe("edge cases", () => {
		it("handles empty string", () => {
			expect(detectContentType("")).toBe("prose");
		});

		it("handles very long content (uses first 2000 chars)", () => {
			const longCode = "import x from 'y';\n".repeat(200);
			expect(detectContentType(longCode)).toBe("code");
		});

		it("prioritizes file extension over content patterns", () => {
			expect(detectContentType('{"json": true}', { filePath: "data.ts" })).toBe("code");
		});
	});
});
