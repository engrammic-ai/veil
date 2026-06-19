import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { parseSessionEntries, type SessionMessageEntry } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { type TruncationResult, truncateHead } from "./truncate.ts";

const sessionSearchSchema = Type.Object({
	query: Type.String({ description: "Search pattern (case-insensitive substring match)" }),
	role: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("any")], {
			description: "Filter by message role (default: any)",
		}),
	),
	since: Type.Optional(
		Type.String({
			description: "Only search sessions newer than this (e.g., '1d', '7d', '2026-06-01')",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Filter by working directory path (substring match on session cwd)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 20)" })),
});

export type SessionSearchToolInput = Static<typeof sessionSearchSchema>;

export interface SessionSearchToolDetails {
	truncation?: TruncationResult;
	totalMatches?: number;
	sessionsSearched?: number;
}

interface SessionMatch {
	sessionFile: string;
	sessionCwd: string;
	timestamp: string;
	role: "user" | "assistant";
	content: string;
	matchLine: string;
}

const DEFAULT_LIMIT = 20;
const MAX_CONTENT_LENGTH = 500;

function parseSince(since: string): Date {
	const now = new Date();

	const relativeMatch = since.match(/^(\d+)([dhwm])$/);
	if (relativeMatch) {
		const [, amount, unit] = relativeMatch;
		const num = parseInt(amount, 10);
		switch (unit) {
			case "d":
				return new Date(now.getTime() - num * 24 * 60 * 60 * 1000);
			case "h":
				return new Date(now.getTime() - num * 60 * 60 * 1000);
			case "w":
				return new Date(now.getTime() - num * 7 * 24 * 60 * 60 * 1000);
			case "m":
				return new Date(now.getTime() - num * 30 * 24 * 60 * 60 * 1000);
		}
	}

	const date = new Date(since);
	if (!Number.isNaN(date.getTime())) {
		return date;
	}

	return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function findMatchingLine(content: string, query: string): string {
	const lines = content.split("\n");
	const lowerQuery = query.toLowerCase();
	for (const line of lines) {
		if (line.toLowerCase().includes(lowerQuery)) {
			return line.length > 200 ? `${line.slice(0, 197)}...` : line;
		}
	}
	return content.slice(0, 200);
}

function searchSessions(input: SessionSearchToolInput): {
	matches: SessionMatch[];
	sessionsSearched: number;
	totalMatches: number;
} {
	const sessionsBase = join(homedir(), ".pi/agent/sessions");
	const limit = input.limit ?? DEFAULT_LIMIT;
	const roleFilter = input.role ?? "any";
	const sinceDate = input.since ? parseSince(input.since) : null;
	const cwdFilter = input.cwd?.toLowerCase();
	const queryLower = input.query.toLowerCase();

	const matches: SessionMatch[] = [];
	let sessionsSearched = 0;
	let totalMatches = 0;

	try {
		const sessionDirs = readdirSync(sessionsBase);

		for (const dir of sessionDirs) {
			if (cwdFilter && !dir.toLowerCase().includes(cwdFilter)) {
				continue;
			}

			const dirPath = join(sessionsBase, dir);
			if (!statSync(dirPath).isDirectory()) continue;

			const sessionFiles = readdirSync(dirPath)
				.filter((f) => f.endsWith(".jsonl"))
				.sort()
				.reverse();

			for (const file of sessionFiles) {
				if (sinceDate) {
					const dateStr = file.slice(0, 10);
					const fileDate = new Date(dateStr);
					if (fileDate < sinceDate) continue;
				}

				const filePath = join(dirPath, file);
				sessionsSearched++;

				try {
					const content = readFileSync(filePath, "utf8");
					const entries = parseSessionEntries(content);

					const headerLine = content.split("\n")[0];
					let sessionCwd = dir;
					try {
						const header = JSON.parse(headerLine);
						if (header.cwd) sessionCwd = header.cwd;
					} catch {
						// ignore parse errors
					}

					for (const entry of entries) {
						if (entry.type !== "message") continue;
						const msgEntry = entry as SessionMessageEntry;
						const { role } = msgEntry.message;
						const msgContent = (msgEntry.message as { content?: unknown }).content;

						if (role !== "user" && role !== "assistant") continue;
						if (roleFilter !== "any" && role !== roleFilter) continue;

						const text = extractTextContent(msgContent);
						if (!text.toLowerCase().includes(queryLower)) continue;

						totalMatches++;

						if (matches.length < limit) {
							matches.push({
								sessionFile: file,
								sessionCwd,
								timestamp: entry.timestamp,
								role: role as "user" | "assistant",
								content: text.length > MAX_CONTENT_LENGTH ? `${text.slice(0, MAX_CONTENT_LENGTH)}...` : text,
								matchLine: findMatchingLine(text, input.query),
							});
						}
					}
				} catch {
					// Skip unreadable session files
				}

				if (matches.length >= limit && totalMatches > limit * 2) {
					break;
				}
			}

			if (matches.length >= limit && totalMatches > limit * 2) {
				break;
			}
		}
	} catch {
		// Sessions directory doesn't exist
	}

	return { matches, sessionsSearched, totalMatches };
}

function formatSessionSearchCall(
	args: { query?: string; role?: string; since?: string; cwd?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const query = args?.query ?? "";
	const role = args?.role;
	const since = args?.since;
	const cwd = args?.cwd;
	const limit = args?.limit;

	let text = `${theme.fg("toolTitle", theme.bold("session_search"))} ${theme.fg("accent", `"${query}"`)}`;

	if (role && role !== "any") text += theme.fg("muted", ` role=${role}`);
	if (since) text += theme.fg("muted", ` since=${since}`);
	if (cwd) text += theme.fg("muted", ` cwd=${cwd}`);
	if (limit) text += theme.fg("muted", ` limit=${limit}`);

	return text;
}

export interface SessionSearchToolOptions {}

export function createSessionSearchToolDefinition(
	_cwd: string,
	_options?: SessionSearchToolOptions,
): ToolDefinition<typeof sessionSearchSchema, SessionSearchToolDetails> {
	return {
		name: "session_search",
		label: "session_search",
		description:
			"Search past session transcripts for patterns or topics. Use to recall what was discussed in previous conversations.",
		promptSnippet: "Search past session transcripts",
		parameters: sessionSearchSchema,
		async execute(_toolCallId: string, input: SessionSearchToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const { matches, sessionsSearched, totalMatches } = searchSessions(input);

			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No matches found for "${input.query}"${input.since ? ` since ${input.since}` : ""}.`,
						},
					],
					details: { sessionsSearched, totalMatches: 0 },
				};
			}

			const lines: string[] = [];
			lines.push(`Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} (showing ${matches.length}):\n`);

			for (const match of matches) {
				const date = match.timestamp.split("T")[0];
				lines.push(`[${date}] [${match.role.toUpperCase()}] ${match.sessionCwd}`);
				lines.push(`  ${match.matchLine}`);
				lines.push("");
			}

			let output = lines.join("\n");
			let truncation: TruncationResult | undefined;

			const maxBytes = 50000;
			if (output.length > maxBytes) {
				const result = truncateHead(output, { maxBytes });
				output = result.content;
				truncation = result;
			}

			return {
				content: [{ type: "text" as const, text: output }],
				details: { truncation, sessionsSearched, totalMatches },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSessionSearchCall(args, theme));
			return text;
		},
		renderResult(result, _options: ToolRenderResultOptions, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = (result as { details?: SessionSearchToolDetails }).details;

			let header = "";
			if (details?.totalMatches !== undefined) {
				header = theme.fg("muted", `(${details.totalMatches} matches across ${details.sessionsSearched} sessions)`);
			}
			if (details?.truncation) {
				header += header ? " " : "";
				header += theme.fg("warning", `[truncated]`);
			}

			const content =
				result.content
					?.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") ?? "";

			text.setText(header ? `${header}\n${content}` : content);
			return text;
		},
	};
}

export function createSessionSearchTool(
	cwd: string,
	options?: SessionSearchToolOptions,
): AgentTool<typeof sessionSearchSchema> {
	return wrapToolDefinition(createSessionSearchToolDefinition(cwd, options));
}
