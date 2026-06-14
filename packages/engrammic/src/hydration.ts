// packages/engrammic/src/hydration.ts

import { readFileSync } from "node:fs";
import type { ContextItem } from "./types.ts";

export const STUB_PATTERN = /\[(EPISODE|FACT|PROC|FILE):([^\]]+)\]/g;

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
		const parts = rest.split(":");
		const path = parts[0];
		const lineRange = parts[1];
		let lines: ParsedStub["lines"];

		if (lineRange) {
			const [start, end] = lineRange.split("-").map(Number);
			lines = { start, end: end ?? start };
		}

		return { type, id: path, path, lines, raw: stub };
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

function hydrateFile(parsed: ParsedStub): HydrationResult {
	if (!parsed.path) {
		return { error: "Invalid FILE stub: missing path" };
	}

	try {
		const content = readFileSync(parsed.path, "utf-8");

		if (parsed.lines) {
			const lines = content.split("\n");
			const { start, end } = parsed.lines;
			const slice = lines.slice(start - 1, end).join("\n");
			return { content: slice };
		}

		return { content };
	} catch (_err) {
		return { error: `File not found: ${parsed.path}` };
	}
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
