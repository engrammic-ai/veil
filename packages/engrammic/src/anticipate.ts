// packages/engrammic/src/anticipate.ts

import type { ContextCache } from "./cache.ts";
import type { ColdStore } from "./cold/interface.ts";
import type { ContextItem, ContextManifest, ManifestItem, Trigger } from "./types.ts";
import { formatRelativeTime } from "./utils.ts";

// Default triggers for common patterns
export const DEFAULT_TRIGGERS: Trigger[] = [
	{
		id: "test",
		pattern: /\b(run|fix|write|check)\s+(the\s+)?tests?\b/i,
		negative: /test\s+(this|that|it|the\s+idea)/i, // Exclude "test this idea"
		type: "keyword",
		action: { tags: ["test"] },
		priority: 10,
		enabled: true,
	},
	{
		id: "debug",
		pattern: /\bdebug(ging)?\b/i,
		type: "keyword",
		action: { tags: ["debug", "error"] },
		priority: 10,
		enabled: true,
	},
	{
		id: "auth",
		pattern: /\bauth(entication|orization)?\b/i,
		type: "keyword",
		action: { tags: ["auth"] },
		priority: 10,
		enabled: true,
	},
	{
		id: "fix",
		pattern: /\bfix(ing|ed)?\s+(the\s+)?(bug|issue|error)/i,
		type: "keyword",
		action: { type: "episodic" },
		priority: 5,
		enabled: true,
	},
];

/**
 * Match triggers against user message.
 * Returns deduplicated list of matching triggers.
 */
export function matchTriggers(message: string, triggers: Trigger[]): Trigger[] {
	const matched: Trigger[] = [];
	const seenActions = new Set<string>();

	// Sort by priority descending
	const sorted = [...triggers].sort((a, b) => b.priority - a.priority);

	for (const trigger of sorted) {
		if (!trigger.enabled) continue;
		if (!trigger.pattern.test(message)) continue;
		if (trigger.negative?.test(message)) continue;

		// Deduplicate by action (avoid querying same tags twice)
		const actionKey = JSON.stringify(trigger.action);
		if (seenActions.has(actionKey)) continue;
		seenActions.add(actionKey);

		matched.push(trigger);
	}

	return matched;
}

/**
 * Build manifest from matched triggers.
 * Queries warm cache first, then cold storage as fallback when budget < 40% and items < 10.
 */
export async function buildManifest(
	triggers: Trigger[],
	cache: ContextCache,
	budget: { percent: number },
	cold?: ColdStore | null,
): Promise<ContextManifest | null> {
	if (triggers.length === 0) return null;
	if (budget.percent > 70) return null;

	const items: ManifestItem[] = [];
	const seenIds = new Set<string>();

	for (const trigger of triggers) {
		let matches: ContextItem[] = [];

		if (trigger.action.tags) {
			matches = cache.getByTags(trigger.action.tags, 10);
		} else if (trigger.action.type) {
			matches = cache.getAll().filter((i) => i.type === trigger.action.type);
		}

		for (const item of matches) {
			if (seenIds.has(item.id)) continue;
			seenIds.add(item.id);

			items.push({
				id: item.id,
				type: item.type,
				tags: item.tags,
				summary: item.content.slice(0, 50).replace(/\n/g, " "),
				age: formatRelativeTime(item.lastAccess),
			});

			if (items.length >= 10) break;
		}

		if (items.length >= 10) break;
	}

	// Query cold storage if budget allows and we have capacity
	if (cold?.query && budget.percent < 40 && items.length < 10) {
		const tags = triggers.flatMap((t) => t.action.tags ?? []);
		const coldItems = await cold.query("", tags, 10 - items.length);

		for (const item of coldItems) {
			if (seenIds.has(item.id)) continue;
			seenIds.add(item.id);
			items.push({
				id: item.id,
				type: item.type,
				tags: item.tags,
				summary: item.content.slice(0, 50).replace(/\n/g, " "),
				age: formatRelativeTime(item.lastAccess),
				source: "cold",
			});
		}
	}

	if (items.length === 0) return null;

	return {
		triggers: triggers.map((t) => t.id),
		budgetPercent: budget.percent,
		items,
	};
}

export function formatManifest(manifest: ContextManifest): string {
	const lines = ["<veil-available>", "Relevant context found (use recall to load):", ""];

	for (const item of manifest.items) {
		const tags = item.tags.slice(0, 2).join(", ");
		const coldIndicator = item.source === "cold" ? " [cold]" : "";
		lines.push(`- ${item.id} [${tags}] "${item.summary}..." (${item.age})${coldIndicator}`);
	}

	lines.push("", `Budget: ${manifest.budgetPercent.toFixed(0)}% used`, "</veil-available>");
	return lines.join("\n");
}
