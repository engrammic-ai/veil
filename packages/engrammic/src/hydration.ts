// packages/engrammic/src/hydration.ts

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ContextItem } from "./types.ts";

export const STUB_PATTERN = /\[(EPISODE|FACT|PROC|FILE):([^\]]+)\]/g;

const FILE_SIZE_CAP = 512 * 1024; // 512KB
const MAX_LINES_PER_RANGE = 500;

// Regex to split FILE stub content on the LAST colon that is followed by a line-range pattern.
// Matches: optional single number OR start-end range at the very end.
const FILE_RANGE_SPLIT = /^([\s\S]+):(\d+(?:-\d+)?)$/;

export interface ParsedStub {
	type: "EPISODE" | "FACT" | "PROC" | "FILE";
	id: string;
	summary?: string;
	path?: string;
	lines?: { start: number; end: number };
	raw: string;
}

export function parseStub(stub: string): ParsedStub | null {
	const match = stub.match(/^\[(EPISODE|FACT|PROC|FILE):([^\]]+)\]$/);
	if (!match) return null;

	const type = match[1] as ParsedStub["type"];
	const rest = match[2];

	if (type === "FILE") {
		// Split on the LAST colon followed by a line-range so that absolute paths
		// like /home/user/foo.ts:10-20 are handled correctly.
		const rangeMatch = rest.match(FILE_RANGE_SPLIT);
		let path: string;
		let lines: ParsedStub["lines"];

		if (rangeMatch) {
			path = rangeMatch[1];
			const rangeStr = rangeMatch[2];
			const dashIdx = rangeStr.indexOf("-");
			if (dashIdx === -1) {
				// Single-line range e.g. :45
				const lineNum = Number(rangeStr);
				if (Number.isFinite(lineNum) && lineNum > 0) {
					lines = { start: lineNum, end: lineNum };
				}
			} else {
				const start = Number(rangeStr.slice(0, dashIdx));
				const end = Number(rangeStr.slice(dashIdx + 1));
				if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start) {
					lines = { start, end };
				}
			}
		} else {
			path = rest;
		}

		return { type, id: path!, path, lines, raw: stub };
	}

	const colonIdx = rest.indexOf(":");
	if (colonIdx === -1) {
		return { type, id: rest, raw: stub };
	}

	const id = rest.slice(0, colonIdx);
	const summary = rest.slice(colonIdx + 1);
	return { type, id, summary, raw: stub };
}

export function detectStubs(text: string): ParsedStub[] {
	const stubs: ParsedStub[] = [];
	const pattern = new RegExp(STUB_PATTERN.source, STUB_PATTERN.flags);
	let match = pattern.exec(text);

	while (match !== null) {
		const parsed = parseStub(match[0]);
		if (parsed) stubs.push(parsed);
		match = pattern.exec(text);
	}

	return stubs;
}

export type HydrationResult = { content: string; error?: undefined } | { content?: undefined; error: string };

export function hydrateStub(parsed: ParsedStub, cache: { get: (id: string) => ContextItem | null }): HydrationResult {
	if (parsed.type === "FILE") {
		return hydrateFile(parsed);
	}

	const item = cache.get(parsed.id);
	if (!item) {
		return { error: `Item not found: ${parsed.id}` };
	}

	return { content: item.content };
}

function validateFilePath(filePath: string): { safe: boolean; resolved: string; reason?: string } {
	const resolved = resolve(filePath);
	const cwd = process.cwd();

	// Must be within CWD subtree - reject paths outside project root
	if (!resolved.startsWith(`${cwd}/`) && resolved !== cwd) {
		return { safe: false, resolved, reason: "path outside project root" };
	}

	// Block sensitive directories even if within CWD (e.g., symlinked .ssh)
	const sensitivePatterns = ["/.ssh/", "/.aws/", "/.gnupg/", "/.git/objects/"];
	for (const pattern of sensitivePatterns) {
		if (resolved.includes(pattern)) {
			return { safe: false, resolved, reason: "sensitive path blocked" };
		}
	}

	return { safe: true, resolved };
}

function hydrateFile(parsed: ParsedStub): HydrationResult {
	if (!parsed.path) {
		return { error: "Invalid FILE stub: missing path" };
	}

	const { safe, resolved, reason } = validateFilePath(parsed.path);
	if (!safe) {
		return { error: `Unsafe file path rejected: ${reason}` };
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(resolved);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { error: `File not found: ${parsed.path}` };
		}
		if (code === "EACCES") {
			return { error: `Permission denied: ${parsed.path}` };
		}
		return { error: `Cannot access file: ${parsed.path} (${code ?? "unknown error"})` };
	}

	if (stat.size > FILE_SIZE_CAP) {
		return { error: `File too large (${stat.size} bytes, max ${FILE_SIZE_CAP}): ${parsed.path}` };
	}

	let content: string;
	try {
		content = readFileSync(resolved, "utf-8");
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES") {
			return { error: `Permission denied: ${parsed.path}` };
		}
		return { error: `Failed to read file: ${parsed.path} (${code ?? "unknown error"})` };
	}

	if (parsed.lines) {
		const allLines = content.split("\n");
		const { start, end } = parsed.lines;
		// Clamp range to MAX_LINES_PER_RANGE
		const clampedEnd = Math.min(end, start + MAX_LINES_PER_RANGE - 1);
		const slice = allLines.slice(start - 1, clampedEnd).join("\n");
		return { content: slice };
	}

	return { content };
}

export function formatHydratedBlock(stubs: Array<{ stub: ParsedStub; result: HydrationResult }>): string {
	if (stubs.length === 0) return "";

	const lines: string[] = ["<veil-hydrated>"];

	for (const { stub, result } of stubs) {
		lines.push(`[ref: ${stub.raw}]`);
		if (result.error) {
			lines.push(`Error: ${result.error}`);
		} else {
			lines.push(result.content ?? "");
		}
		lines.push("");
	}

	lines.push("</veil-hydrated>");
	return lines.join("\n");
}
