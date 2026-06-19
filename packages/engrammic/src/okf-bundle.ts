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
