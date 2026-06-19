/**
 * Trigger-based auto-recall: event-driven context retrieval based on tool activity.
 */

import type { ContextCache } from "./cache.ts";
import type { ContextItem } from "./types.ts";

export type TriggerType = "pre_edit" | "pre_bash" | "error_observed" | "pre_search" | "goal_changed" | "file_mentioned";

export interface TriggerContext {
	type: TriggerType;
	filePath?: string;
	command?: string;
	errorText?: string;
	searchTerms?: string;
	goalId?: string;
}

export interface TriggerResult {
	items: ContextItem[];
	reason: string;
}

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[rf]{1,2}|--recursive|--force)/,
	/\bgit\s+(reset\s+--hard|clean\s+-[fdx]+|push\s+--force)/,
	/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,
	/\bTRUNCATE\s+/i,
	/\bdd\s+if=/,
	/\bmkfs\b/,
];

export function isDangerousCommand(cmd: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
}

function handlePreEdit(cache: ContextCache, filePath: string): TriggerResult | null {
	const tags = [`file:${filePath}`];
	const items = cache.getByTags(tags, 10).filter((item) => {
		const itemTags = item.tags;
		return itemTags.some((t) => t === "edit" || t === "error" || t === "write") || item.type === "episodic";
	});

	const limited = items.slice(0, 3);
	if (limited.length === 0) return null;

	return {
		items: limited,
		reason: `Past edits for ${filePath}`,
	};
}

function handlePreBash(cache: ContextCache, command: string): TriggerResult | null {
	if (!isDangerousCommand(command)) return null;

	const items = cache.getByTags(["error", "bash", "shell"], 10).filter((item) => item.cognitiveWeight < 0);

	const limited = items.slice(0, 2);
	if (limited.length === 0) return null;

	return {
		items: limited,
		reason: "Past failures for similar commands",
	};
}

function handleErrorObserved(cache: ContextCache, errorText: string): TriggerResult | null {
	// Extract a short error signature (first non-whitespace line)
	const signature =
		errorText
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? errorText.slice(0, 80);

	// Build search tags from error keywords
	const keywords = signature
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 3)
		.slice(0, 5);

	const searchTags = ["error", ...keywords];
	const candidates = cache.getByTags(searchTags, 20).filter((item) => item.cognitiveWeight < 0);

	// Simple similarity: count matching keywords in content
	const withScore = candidates.map((item) => {
		const content = item.content.toLowerCase();
		const matches = keywords.filter((kw) => content.includes(kw)).length;
		const similarity = keywords.length > 0 ? matches / keywords.length : 0;
		return { item, similarity };
	});

	const similar = withScore
		.filter((s) => s.similarity >= 0.7)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, 2)
		.map((s) => s.item);

	if (similar.length === 0) return null;

	return {
		items: similar,
		reason: "Similar past errors",
	};
}

function handlePreSearch(cache: ContextCache, searchTerms: string): TriggerResult | null {
	const terms = searchTerms
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 2);

	if (terms.length === 0) return null;

	const items = cache.getByTags(["search", "grep", ...terms], 10);
	const limited = items.slice(0, 2);
	if (limited.length === 0) return null;

	return {
		items: limited,
		reason: `Past searches for "${searchTerms}"`,
	};
}

function handleGoalChanged(cache: ContextCache, goalId: string): TriggerResult | null {
	const items = cache.getByTags([`goal:${goalId}`], 5);
	if (items.length === 0) return null;

	return {
		items,
		reason: `Context for goal ${goalId}`,
	};
}

function handleFileMentioned(cache: ContextCache, filePath: string): TriggerResult | null {
	const items = cache.getByTags([`file:${filePath}`], 5);
	const limited = items.slice(0, 2);
	if (limited.length === 0) return null;

	return {
		items: limited,
		reason: `Known context for ${filePath}`,
	};
}

export function handleTrigger(cache: ContextCache, trigger: TriggerContext): TriggerResult | null {
	switch (trigger.type) {
		case "pre_edit":
			if (!trigger.filePath) return null;
			return handlePreEdit(cache, trigger.filePath);

		case "pre_bash":
			if (!trigger.command) return null;
			return handlePreBash(cache, trigger.command);

		case "error_observed":
			if (!trigger.errorText) return null;
			return handleErrorObserved(cache, trigger.errorText);

		case "pre_search":
			if (!trigger.searchTerms) return null;
			return handlePreSearch(cache, trigger.searchTerms);

		case "goal_changed":
			if (!trigger.goalId) return null;
			return handleGoalChanged(cache, trigger.goalId);

		case "file_mentioned":
			if (!trigger.filePath) return null;
			return handleFileMentioned(cache, trigger.filePath);

		default:
			return null;
	}
}
