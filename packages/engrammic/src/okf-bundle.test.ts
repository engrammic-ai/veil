import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextCache, createItem } from "./cache.ts";
import { ContextManager } from "./manager.ts";
import { exportBundle, importBundle, parseMemoryFile } from "./okf-bundle.ts";

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

// ─── parseMemoryFile tests ────────────────────────────────────────────────────

describe("parseMemoryFile", () => {
	it("parses valid markdown with flow-style tags", () => {
		const content = `---
type: fact
title: "A test fact"
timestamp: "2024-01-01T00:00:00.000Z"
tags: [lang:ts, memory]
stability: 0.8000
difficulty: 0.5000
---

This is the body text.`;
		const parsed = parseMemoryFile(content);
		expect(parsed).not.toBeNull();
		expect(parsed!.frontmatter.type).toBe("fact");
		expect(parsed!.frontmatter.title).toBe("A test fact");
		expect(parsed!.frontmatter.tags).toEqual(["lang:ts", "memory"]);
		expect(parsed!.body).toBe("This is the body text.");
	});

	it("parses links block", () => {
		const content = `---
type: edit
title: "Edit memory"
timestamp: "2024-01-01T00:00:00.000Z"
tags: []
links:
  - rel: file
    target: src/foo.ts
    label: "source file"
---

Body here.`;
		const parsed = parseMemoryFile(content);
		expect(parsed).not.toBeNull();
		expect(parsed!.frontmatter.links).toHaveLength(1);
		expect(parsed!.frontmatter.links![0]).toMatchObject({ rel: "file", target: "src/foo.ts", label: "source file" });
	});

	it("returns null for content without frontmatter", () => {
		expect(parseMemoryFile("just plain text")).toBeNull();
	});

	it("returns null for incomplete frontmatter (missing type)", () => {
		const content = `---
title: "Missing type"
timestamp: "2024-01-01T00:00:00.000Z"
tags: []
---

Body.`;
		expect(parseMemoryFile(content)).toBeNull();
	});

	it("returns null for unclosed frontmatter", () => {
		const content = `---
type: fact
title: "No closing marker"
timestamp: "2024-01-01T00:00:00.000Z"
tags: []`;
		expect(parseMemoryFile(content)).toBeNull();
	});
});

// ─── importBundle tests ───────────────────────────────────────────────────────

describe("importBundle", () => {
	let importDir: string;
	let importCache: ContextCache;
	let manager: ContextManager;
	let importDbDir: string;

	function makeMemoryFile(
		overrides: Partial<{
			type: string;
			title: string;
			timestamp: string;
			tags: string;
			body: string;
			extraFrontmatter: string;
		}> = {},
	): string {
		const {
			type = "fact",
			title = "Test Memory",
			timestamp = "2024-01-01T00:00:00.000Z",
			tags = "[]",
			body = "Memory body content.",
			extraFrontmatter = "",
		} = overrides;
		return `---\ntype: ${type}\ntitle: "${title}"\ntimestamp: "${timestamp}"\ntags: ${tags}\n${extraFrontmatter}---\n\n${body}`;
	}

	beforeEach(async () => {
		importDir = await mkdtemp(join(tmpdir(), "okf-import-"));
		importDbDir = await mkdtemp(join(tmpdir(), "okf-import-db-"));
		await mkdir(join(importDir, "memories"), { recursive: true });
		importCache = new ContextCache(join(importDbDir, "cache.db"));
		manager = new ContextManager({ dbPath: join(importDbDir, "ctx.db") });
	});

	afterEach(async () => {
		importCache.close();
		await manager.close();
		await rm(importDir, { recursive: true, force: true });
		await rm(importDbDir, { recursive: true, force: true });
	});

	it("imports valid markdown files and creates items", async () => {
		await writeFile(
			join(importDir, "memories", "mem1.md"),
			makeMemoryFile({ body: "Unique fact about TypeScript generics.", tags: "[lang:ts]" }),
		);

		const result = await importBundle(importCache, manager, { inputDir: importDir });

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	it("maps OKF types to ContextItemType correctly", async () => {
		await writeFile(join(importDir, "memories", "fact.md"), makeMemoryFile({ type: "fact", body: "A fact body." }));
		await writeFile(
			join(importDir, "memories", "proc.md"),
			makeMemoryFile({ type: "procedure", body: "A procedure body." }),
		);
		await writeFile(
			join(importDir, "memories", "bash.md"),
			makeMemoryFile({ type: "bash", body: "A bash body here." }),
		);
		await writeFile(
			join(importDir, "memories", "decision.md"),
			makeMemoryFile({ type: "decision", body: "A decision body text." }),
		);

		const result = await importBundle(importCache, manager, { inputDir: importDir });
		expect(result.imported).toBe(4);
		expect(result.errors).toHaveLength(0);

		const managerCache = manager.getCache();
		const all = managerCache.getAll();
		const types = all.map((i) => i.type).sort();
		expect(types).toContain("fact");
		expect(types).toContain("procedural");
		expect(types.filter((t) => t === "episodic")).toHaveLength(2);
	});

	it("skips duplicate content when merge=false (default)", async () => {
		const content = makeMemoryFile({ body: "Duplicate content here." });
		await writeFile(join(importDir, "memories", "dup.md"), content);

		const r1 = await importBundle(importCache, manager, { inputDir: importDir });
		expect(r1.imported).toBe(1);

		const r2 = await importBundle(importCache, manager, { inputDir: importDir });
		expect(r2.imported).toBe(0);
		expect(r2.skipped).toBe(1);
	});

	it("re-imports duplicate content when merge=true", async () => {
		const content = makeMemoryFile({ body: "Content to merge and reimport." });
		await writeFile(join(importDir, "memories", "merge.md"), content);

		const r1 = await importBundle(importCache, manager, { inputDir: importDir });
		expect(r1.imported).toBe(1);

		const r2 = await importBundle(importCache, manager, { inputDir: importDir, merge: true });
		expect(r2.imported).toBe(1);
		expect(r2.skipped).toBe(0);
	});

	it("imports links from frontmatter", async () => {
		const content = makeMemoryFile({
			body: "Memory with links to a file.",
			extraFrontmatter: "links:\n  - rel: file\n    target: src/index.ts\n",
		});
		await writeFile(join(importDir, "memories", "linked.md"), content);

		const result = await importBundle(importCache, manager, { inputDir: importDir });
		expect(result.imported).toBe(1);

		const managerCache = manager.getCache();
		const all = managerCache.getAll();
		expect(all).toHaveLength(1);
		const links = managerCache.getLinks(all[0].id);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ rel: "file", target: "src/index.ts" });
	});

	it("records errors for invalid files and continues processing", async () => {
		await writeFile(join(importDir, "memories", "bad.md"), "no frontmatter here at all");
		await writeFile(join(importDir, "memories", "good.md"), makeMemoryFile({ body: "Valid file content." }));

		const result = await importBundle(importCache, manager, { inputDir: importDir });
		expect(result.imported).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Invalid format");
	});

	it("returns error when memories directory does not exist", async () => {
		const result = await importBundle(importCache, manager, { inputDir: "/nonexistent/path/xyz" });
		expect(result.imported).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Cannot read memories directory");
	});

	it("skips non-.md files", async () => {
		await writeFile(join(importDir, "memories", "readme.txt"), "not a memory");
		await writeFile(join(importDir, "memories", "notes.json"), "{}");

		const result = await importBundle(importCache, manager, { inputDir: importDir });
		expect(result.imported).toBe(0);
		expect(result.errors).toHaveLength(0);
	});
});
