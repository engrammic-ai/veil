import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextCache, createItem } from "./cache.ts";
import { exportBundle } from "./okf-bundle.ts";

let outputDir: string;
let dbDir: string;
let cache: ContextCache;

beforeEach(async () => {
	outputDir = await mkdtemp(join(tmpdir(), "okf-export-"));
	dbDir = await mkdtemp(join(tmpdir(), "okf-cache-"));
	cache = new ContextCache(join(dbDir, "test.db"));
});

afterEach(async () => {
	cache.close();
	await rm(outputDir, { recursive: true, force: true });
	await rm(dbDir, { recursive: true, force: true });
});

describe("exportBundle — file creation", () => {
	it("creates memories directory and index.md", async () => {
		const item = createItem("test memory content", "episodic", ["tag:test"]);
		cache.put(item);

		const result = await exportBundle(cache, { outputDir });

		expect(result.exported).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.outputPath).toBe(outputDir);

		// index.md must exist
		const index = await readFile(join(outputDir, "index.md"), "utf8");
		expect(index).toContain("# Memory Bundle Export");
		expect(index).toContain("Total: 1 memories");
	});

	it("writes one markdown file per memory", async () => {
		const item = createItem("hello world memory", "fact", ["tag:fact"]);
		cache.put(item);

		const result = await exportBundle(cache, { outputDir });
		expect(result.exported).toBe(1);

		// Find the file
		const filename = `${item.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.md`;
		const content = await readFile(join(outputDir, "memories", filename), "utf8");
		expect(content).toContain("hello world memory");
	});
});

describe("exportBundle — frontmatter format", () => {
	it("includes required frontmatter fields", async () => {
		const item = createItem("frontmatter check content", "episodic", ["lang:ts", "file:foo.ts"]);
		cache.put(item);

		const filename = `${item.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.md`;
		await exportBundle(cache, { outputDir });

		const content = await readFile(join(outputDir, "memories", filename), "utf8");
		expect(content).toMatch(/^---/);
		expect(content).toContain(`id: ${item.id}`);
		expect(content).toContain("type: episodic");
		expect(content).toContain("timestamp:");
		expect(content).toContain("stability:");
		expect(content).toContain("difficulty:");
		expect(content).toContain("tags: [lang:ts, file:foo.ts]");
	});

	it("includes links in frontmatter when present", async () => {
		const item = createItem("item with links", "episodic", []);
		cache.put(item);
		cache.addLinks(item.id, [{ rel: "file", target: "src/foo.ts" }]);

		const filename = `${item.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)}.md`;
		await exportBundle(cache, { outputDir });

		const content = await readFile(join(outputDir, "memories", filename), "utf8");
		expect(content).toContain("links:");
		expect(content).toContain("rel: file");
		expect(content).toContain("target: src/foo.ts");
	});
});

describe("exportBundle — index generation", () => {
	it("includes type breakdown in index", async () => {
		cache.put(createItem("episodic memory one", "episodic", []));
		cache.put(createItem("episodic memory two", "episodic", []));
		cache.put(createItem("fact memory", "fact", []));

		await exportBundle(cache, { outputDir });

		const index = await readFile(join(outputDir, "index.md"), "utf8");
		expect(index).toContain("## By Type");
		expect(index).toContain("episodic: 2");
		expect(index).toContain("fact: 1");
	});

	it("includes recent memories section with links", async () => {
		const item = createItem("recent memory content", "procedural", []);
		cache.put(item);

		await exportBundle(cache, { outputDir });

		const index = await readFile(join(outputDir, "index.md"), "utf8");
		expect(index).toContain("## Recent (top 10 by last access)");
		expect(index).toContain(item.id);
		expect(index).toContain("memories/");
		expect(index).toContain(".md");
	});

	it("reports total exported count", async () => {
		cache.put(createItem("item a", "episodic", []));
		cache.put(createItem("item b", "fact", []));

		const result = await exportBundle(cache, { outputDir });
		expect(result.exported).toBe(2);

		const index = await readFile(join(outputDir, "index.md"), "utf8");
		expect(index).toContain("Total: 2 memories");
	});
});

describe("exportBundle — filtering", () => {
	it("filters by type", async () => {
		cache.put(createItem("episodic item", "episodic", []));
		cache.put(createItem("fact item", "fact", []));

		const result = await exportBundle(cache, { outputDir, types: ["fact"] });
		expect(result.exported).toBe(1);
		expect(result.skipped).toBe(1);

		const index = await readFile(join(outputDir, "index.md"), "utf8");
		expect(index).toContain("fact: 1");
		expect(index).not.toContain("episodic");
	});

	it("filters by minRetrievability (stability)", async () => {
		const lowStability = createItem("low stability item", "episodic", []);
		lowStability.stability = 0.1;
		cache.put(lowStability);

		const highStability = createItem("high stability item", "episodic", []);
		highStability.stability = 0.9;
		cache.put(highStability);

		const result = await exportBundle(cache, { outputDir, minRetrievability: 0.5 });
		expect(result.exported).toBe(1);
		expect(result.skipped).toBe(1);
	});

	it("excludes fully decayed items when includeStale=false", async () => {
		const staleItem = createItem("stale item", "episodic", []);
		staleItem.decayScore = 1.0;
		cache.put(staleItem);

		const freshItem = createItem("fresh item", "episodic", []);
		freshItem.decayScore = 0.0;
		cache.put(freshItem);

		const result = await exportBundle(cache, { outputDir, includeStale: false });
		expect(result.exported).toBe(1);
		expect(result.skipped).toBe(1);
	});

	it("includes stale items by default", async () => {
		const staleItem = createItem("stale item included", "episodic", []);
		staleItem.decayScore = 1.0;
		cache.put(staleItem);

		const result = await exportBundle(cache, { outputDir });
		expect(result.exported).toBe(1);
		expect(result.skipped).toBe(0);
	});
});

describe("exportBundle — empty cache", () => {
	it("handles empty cache gracefully", async () => {
		const result = await exportBundle(cache, { outputDir });
		expect(result.exported).toBe(0);
		expect(result.skipped).toBe(0);

		const index = await readFile(join(outputDir, "index.md"), "utf8");
		expect(index).toContain("Total: 0 memories");
	});
});
