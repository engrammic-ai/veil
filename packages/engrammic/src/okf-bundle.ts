/**
 * OKF bundle export/import — dump and ingest warm cache memories as portable markdown files.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextCache } from "./cache.ts";
import { hashContent } from "./cache.ts";
import type { CaptureLink } from "./capture-document.ts";
import type { ContextManager } from "./manager.ts";
import type { ContextItem, ContextItemType } from "./types.ts";

export interface ExportOptions {
	outputDir: string;
	includeStale?: boolean; // default true
	minRetrievability?: number; // filter by FSRS stability score, default 0
	types?: string[]; // filter by type, default all
}

export interface ExportResult {
	exported: number;
	skipped: number;
	outputPath: string;
}

function toISO(ms: number): string {
	return new Date(ms).toISOString();
}

function renderFrontmatter(item: ContextItem, links: Array<{ rel: string; target: string; label?: string }>): string {
	const lines: string[] = ["---"];
	lines.push(`id: ${item.id}`);
	lines.push(`type: ${item.type}`);

	// title from first non-empty content line, truncated
	const firstLine =
		item.content
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? item.id;
	const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
	lines.push(`title: ${JSON.stringify(title)}`);

	lines.push(`timestamp: ${JSON.stringify(toISO(item.createdAt))}`);

	if (item.kgPointer) {
		lines.push(`resource: ${JSON.stringify(item.kgPointer)}`);
	}

	if (item.tags.length > 0) {
		lines.push(`tags: [${item.tags.join(", ")}]`);
	}

	lines.push(`stability: ${item.stability.toFixed(4)}`);
	lines.push(`difficulty: ${item.difficulty.toFixed(4)}`);

	if (links.length > 0) {
		lines.push("links:");
		for (const link of links) {
			lines.push(`  - rel: ${link.rel}`);
			lines.push(`    target: ${link.target}`);
			if (link.label) {
				lines.push(`    label: ${JSON.stringify(link.label)}`);
			}
		}
	}

	lines.push("---");
	return lines.join("\n");
}

function sanitizeId(id: string): string {
	// Replace characters unsafe for filenames
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Export all matching memories from the warm cache to a directory of markdown files.
 */
export async function exportBundle(cache: ContextCache, options: ExportOptions): Promise<ExportResult> {
	const { outputDir, includeStale = true, minRetrievability = 0, types } = options;

	const memoriesDir = join(outputDir, "memories");
	await mkdir(memoriesDir, { recursive: true });

	const allItems = cache.getAll();
	const exportedItems: ContextItem[] = [];
	let skipped = 0;

	for (const item of allItems) {
		// Filter by type
		if (types && types.length > 0 && !types.includes(item.type)) {
			skipped++;
			continue;
		}

		// Filter by stability (proxy for retrievability)
		if (item.stability < minRetrievability) {
			skipped++;
			continue;
		}

		// Filter stale items (decayScore >= 1 means fully decayed)
		if (!includeStale && item.decayScore >= 1) {
			skipped++;
			continue;
		}

		exportedItems.push(item);
	}

	// Write one markdown file per memory
	for (const item of exportedItems) {
		const links = cache.getLinks(item.id);
		const frontmatter = renderFrontmatter(item, links);
		const markdown = `${frontmatter}\n\n${item.content}\n`;
		const filename = `${sanitizeId(item.id)}.md`;
		await writeFile(join(memoriesDir, filename), markdown, "utf8");
	}

	// Write index.md
	const indexContent = buildIndex(exportedItems, outputDir);
	await writeFile(join(outputDir, "index.md"), indexContent, "utf8");

	return {
		exported: exportedItems.length,
		skipped,
		outputPath: outputDir,
	};
}

function buildIndex(items: ContextItem[], _outputDir: string): string {
	const now = new Date().toISOString();
	const lines: string[] = [];

	lines.push("# Memory Bundle Export");
	lines.push("");
	lines.push(`Exported: ${now}`);
	lines.push(`Total: ${items.length} memories`);
	lines.push("");

	// By type counts
	const typeCounts: Record<string, number> = {};
	for (const item of items) {
		typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
	}

	if (Object.keys(typeCounts).length > 0) {
		lines.push("## By Type");
		for (const [type, count] of Object.entries(typeCounts).sort()) {
			lines.push(`- ${type}: ${count}`);
		}
		lines.push("");
	}

	// Recent top 10 by lastAccess
	const recent = [...items].sort((a, b) => b.lastAccess - a.lastAccess).slice(0, 10);
	if (recent.length > 0) {
		lines.push("## Recent (top 10 by last access)");
		for (const item of recent) {
			const firstLine =
				item.content
					.split("\n")
					.map((l) => l.trim())
					.find((l) => l.length > 0) ?? item.id;
			const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
			const filename = `${sanitizeId(item.id)}.md`;
			lines.push(`- [${item.id}](memories/${filename}) - ${title}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ─── Import ───────────────────────────────────────────────────────────────────

export interface ImportOptions {
	inputDir: string;
	merge?: boolean;
	preserveIds?: boolean;
}

export interface ImportResult {
	imported: number;
	skipped: number;
	errors: string[];
}

interface ParsedFrontmatter {
	id?: string;
	type: string;
	title: string;
	timestamp: string;
	resource?: string;
	tags: string[];
	outcome?: string;
	stability?: number;
	difficulty?: number;
	links?: Array<{ rel: string; target: string; label?: string }>;
}

interface ParsedMemory {
	frontmatter: ParsedFrontmatter;
	body: string;
}

export function parseMemoryFile(content: string): ParsedMemory | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return null;

	const yamlBlock = content.slice(3, end).trim();
	const body = content.slice(end + 4).trim();

	const fm = parseYaml(yamlBlock);
	if (!fm.type || !fm.title || !fm.timestamp) return null;
	if (!Array.isArray(fm.tags)) fm.tags = [];
	return { frontmatter: fm as unknown as ParsedFrontmatter, body };
}

function parseScalar(s: string): string | number | boolean {
	s = s.trim();
	if (s === "true") return true;
	if (s === "false") return false;
	const n = Number(s);
	if (!Number.isNaN(n) && s !== "") return n;
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	return s;
}

function parseYaml(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");
	let i = 0;

	while (i < lines.length) {
		const keyMatch = lines[i].match(/^(\w[\w-]*):\s*(.*)?$/);
		if (!keyMatch) {
			i++;
			continue;
		}

		const key = keyMatch[1];
		const rest = (keyMatch[2] ?? "").trim();

		if (rest === "" && lines[i + 1]?.match(/^\s+-/)) {
			const items: unknown[] = [];
			i++;
			while (i < lines.length && lines[i].match(/^\s+-\s/)) {
				const m = lines[i].match(/^\s+-\s+(.*)/);
				if (m) items.push(parseScalar(m[1]));
				i++;
			}
			result[key] = items;
		} else if (rest.startsWith("[")) {
			const inner = rest.slice(1, rest.lastIndexOf("]"));
			result[key] = inner
				.split(",")
				.map((s) => parseScalar(s.trim()))
				.filter((s) => s !== "");
			i++;
		} else {
			result[key] = parseScalar(rest);
			i++;
		}
	}

	const linksBlock = parseLinksBlock(yaml);
	if (linksBlock !== null) result.links = linksBlock;

	return result;
}

function parseLinksBlock(yaml: string): Array<{ rel: string; target: string; label?: string }> | null {
	const linksIdx = yaml.search(/^links:/m);
	if (linksIdx === -1) return null;

	const after = yaml.slice(linksIdx + 6);
	const items: Array<{ rel: string; target: string; label?: string }> = [];
	let cur: Partial<{ rel: string; target: string; label: string }> | null = null;

	for (const line of after.split("\n")) {
		const newItemField = line.match(/^\s+-\s+(rel|target|label):\s*(.*)/);
		if (newItemField) {
			if (cur?.rel && cur.target) items.push(cur as { rel: string; target: string; label?: string });
			cur = { [newItemField[1]]: parseScalar(newItemField[2]).toString() };
			continue;
		}
		const contField = line.match(/^\s{2,}(rel|target|label):\s*(.*)/);
		if (contField && cur) {
			cur[contField[1] as "rel" | "target" | "label"] = parseScalar(contField[2]).toString();
			continue;
		}
		if (line.match(/^\w/) && !line.match(/^-\s/)) break;
	}

	if (cur?.rel && cur.target) items.push(cur as { rel: string; target: string; label?: string });
	return items.length > 0 ? items : null;
}

const OKF_TYPE_MAP: Record<string, ContextItemType> = {
	edit: "episodic",
	error: "episodic",
	read: "episodic",
	bash: "episodic",
	decision: "episodic",
	fact: "fact",
	procedure: "procedural",
};

function mapType(okfType: string): ContextItemType {
	return OKF_TYPE_MAP[okfType] ?? "episodic";
}

const ALLOWED_LINK_RELS = new Set<string>(["caused_by", "fixes", "supersedes", "related", "file", "error"]);

function toCaptureLinkRel(rel: string): CaptureLink["rel"] {
	return (ALLOWED_LINK_RELS.has(rel) ? rel : "related") as CaptureLink["rel"];
}

export async function importBundle(
	_cache: ContextCache,
	manager: ContextManager,
	options: ImportOptions,
): Promise<ImportResult> {
	const result: ImportResult = { imported: 0, skipped: 0, errors: [] };
	const memoriesDir = join(options.inputDir, "memories");
	const cache = manager.getCache();

	let files: string[];
	try {
		files = await readdir(memoriesDir);
	} catch {
		result.errors.push(`Cannot read memories directory: ${memoriesDir}`);
		return result;
	}

	for (const file of files) {
		if (!file.endsWith(".md")) continue;

		let content: string;
		try {
			content = await readFile(join(memoriesDir, file), "utf-8");
		} catch {
			result.errors.push(`Failed to read file: ${file}`);
			continue;
		}

		const parsed = parseMemoryFile(content);
		if (!parsed) {
			result.errors.push(`Invalid format: ${file}`);
			continue;
		}

		const bodyHash = hashContent(parsed.body);
		const existing = cache.getByHash(bodyHash);
		if (existing && !options.merge) {
			result.skipped++;
			continue;
		}

		const type = mapType(parsed.frontmatter.type);
		const item = manager.remember(parsed.body, type, parsed.frontmatter.tags);

		if (parsed.frontmatter.links?.length) {
			const captureLinks: CaptureLink[] = parsed.frontmatter.links.map((l) => ({
				rel: toCaptureLinkRel(l.rel),
				target: l.target,
				...(l.label ? { label: l.label } : {}),
			}));
			cache.addLinks(item.id, captureLinks);
		}

		result.imported++;
	}

	return result;
}
