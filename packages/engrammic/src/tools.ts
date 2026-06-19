// packages/engrammic/src/tools.ts

import { hydrateStub, parseStub } from "./hydration.ts";
import { formatStub } from "./injection.ts";
import type { ContextManager } from "./manager.ts";
import type { ContextItem } from "./types.ts";

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
		required: string[];
	};
}

export const TOOL_SCHEMAS: ToolDefinition[] = [
	{
		name: "veil_recall",
		description:
			"Search your memory for relevant past context. Returns matching items as stubs you can hydrate or promote.",
		parameters: {
			type: "object",
			properties: {
				tags: { type: "array", items: { type: "string" }, description: "Tags to search for" },
				limit: { type: "number", description: "Maximum number of results (default: 10)" },
			},
			required: ["tags"],
		},
	},
	{
		name: "veil_promote",
		description:
			"Bring an item into your active context so it's visible every turn. Use when you'll reference something repeatedly.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "ID of the item to promote" },
			},
			required: ["id"],
		},
	},
	{
		name: "veil_demote",
		description: "Remove an item from active context to free up budget. Item stays in memory for later recall.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "ID of the item to demote" },
			},
			required: ["id"],
		},
	},
	{
		name: "veil_remember",
		description: "Store something important for later. Use for insights, decisions, or facts you'll need again.",
		parameters: {
			type: "object",
			properties: {
				content: { type: "string", description: "Content to remember" },
				type: {
					type: "string",
					description: "Type of memory",
					enum: ["episodic", "fact", "procedural"],
				},
				tags: { type: "array", items: { type: "string" }, description: "Tags for later retrieval" },
			},
			required: ["content", "type"],
		},
	},
	{
		name: "veil_pin",
		description: "Lock an item in active context. Pinned items survive eviction even under budget pressure.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "ID of the item to pin" },
			},
			required: ["id"],
		},
	},
	{
		name: "veil_unpin",
		description: "Unlock a pinned item, allowing it to be evicted if needed.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "ID of the item to unpin" },
			},
			required: ["id"],
		},
	},
	{
		name: "veil_forget",
		description: "Permanently delete something from all memory tiers. Cannot be undone.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "ID of the item to forget" },
			},
			required: ["id"],
		},
	},
	{
		name: "veil_hydrate",
		description: "Expand a stub to see its full content. Use when you need the details, not just the summary.",
		parameters: {
			type: "object",
			properties: {
				stub: { type: "string", description: 'Stub to hydrate, e.g., "[EPISODE:abc123]"' },
			},
			required: ["stub"],
		},
	},
	{
		name: "veil_history",
		description: "Search past sessions for related context",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to search for" },
				days: { type: "number", description: "How far back to search (default: 7)" },
			},
			required: ["query"],
		},
	},
];

// Tool implementations

export interface ToolContext {
	manager: ContextManager;
	onRecall?: (ids: string[]) => void;
}

export type ToolResult = { success: boolean; data?: unknown; error?: string };

export async function executeVeilTool(
	name: string,
	params: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	switch (name) {
		case "veil_recall":
			return executeRecall(params as { tags: string[]; limit?: number }, ctx);
		case "veil_promote":
			return await executePromote(params as { id: string }, ctx);
		case "veil_demote":
			return executeDemote(params as { id: string }, ctx);
		case "veil_remember":
			return executeRemember(params as { content: string; type: ContextItem["type"]; tags?: string[] }, ctx);
		case "veil_pin":
			return executePin(params as { id: string }, ctx);
		case "veil_unpin":
			return executeUnpin(params as { id: string }, ctx);
		case "veil_forget":
			return await executeForget(params as { id: string }, ctx);
		case "veil_hydrate":
			return await executeHydrate(params as { stub: string }, ctx);
		case "veil_history":
			return await executeVeilHistory(params as { query: string; days?: number }, ctx);
		default:
			return { success: false, error: `Unknown tool: ${name}` };
	}
}

async function executeRecall(params: { tags: string[]; limit?: number }, ctx: ToolContext): Promise<ToolResult> {
	const items = await ctx.manager.recall(params.tags, params.limit ?? 10);
	const result = items.map((item) => ({ id: item.id, stub: formatStub(item) }));
	ctx.onRecall?.(items.map((i) => i.id));

	const formatted = wrapToolResult("recall", result.length, result.map((r) => r.stub).join("\n"));
	return { success: true, data: { formatted, items: result } };
}

async function executePromote(params: { id: string }, ctx: ToolContext): Promise<ToolResult> {
	let items = ctx.manager.load([params.id]);
	if (items.length === 0) {
		// Try fetching from cold storage (this also puts it in cache)
		const coldItem = await ctx.manager.fetchFromCold(params.id);
		if (coldItem) {
			// Now load it into the active set
			items = ctx.manager.load([coldItem.id]);
		}
		if (items.length === 0) {
			return { success: false, error: `Item not found: ${params.id}` };
		}
	}
	ctx.manager.setRecallCooldown(params.id);
	const stub = formatStub(items[0]);
	return { success: true, data: { id: items[0].id, stub } };
}

function executeDemote(params: { id: string }, ctx: ToolContext): ToolResult {
	const window = ctx.manager.getWindow();
	const exists = window.items.some((item) => item.id === params.id);
	if (!exists) {
		return { success: false, error: `Item not in active context: ${params.id}` };
	}
	ctx.manager.unload([params.id]);
	return { success: true };
}

function executeRemember(
	params: { content: string; type: ContextItem["type"]; tags?: string[] },
	ctx: ToolContext,
): ToolResult {
	const item = ctx.manager.remember(params.content, params.type, params.tags ?? []);
	const stub = formatStub(item);
	return { success: true, data: { id: item.id, stub } };
}

function executePin(params: { id: string }, ctx: ToolContext): ToolResult {
	const item = ctx.manager.getCache().get(params.id);
	if (!item) {
		return { success: false, error: `Item not found: ${params.id}` };
	}
	ctx.manager.pin(params.id);
	return { success: true };
}

function executeUnpin(params: { id: string }, ctx: ToolContext): ToolResult {
	const item = ctx.manager.getCache().get(params.id);
	if (!item) {
		return { success: false, error: `Item not found: ${params.id}` };
	}
	ctx.manager.unpin(params.id);
	return { success: true };
}

async function executeForget(params: { id: string }, ctx: ToolContext): Promise<ToolResult> {
	await ctx.manager.forget(params.id);
	return { success: true };
}

async function executeHydrate(params: { stub: string }, ctx: ToolContext): Promise<ToolResult> {
	const parsed = parseStub(params.stub);
	if (!parsed) {
		// Try treating the stub as a raw ID
		const coldItem = await ctx.manager.fetchFromCold(params.stub);
		if (coldItem) {
			return { success: true, data: { content: coldItem.content } };
		}
		return { success: false, error: `Invalid stub format: ${params.stub}` };
	}

	const result = hydrateStub(parsed, ctx.manager.getCache());
	if (result.error) {
		// Try cold storage fallback
		const coldItem = await ctx.manager.fetchFromCold(parsed.id);
		if (coldItem) {
			return { success: true, data: { content: coldItem.content } };
		}
		return { success: false, error: result.error };
	}

	return { success: true, data: { content: result.content } };
}

async function executeVeilHistory(params: { query: string; days?: number }, ctx: ToolContext): Promise<ToolResult> {
	const since = Date.now() - (params.days ?? 7) * 24 * 60 * 60 * 1000;

	const results = await ctx.manager.searchHistory(params.query, since);

	if (results.length === 0) {
		const formatted = wrapToolResult("history", 0, "No related context found in recent sessions.");
		return { success: true, data: { formatted } };
	}

	const itemList = results.map((r) => `- ${r.id} [${r.type}] "${r.summary}" (${r.sessionDate})`).join("\n");
	const formatted = wrapToolResult("history", results.length, itemList);

	return { success: true, data: { formatted, items: results } };
}

// Wrap tool results in explicit tags for better model interpretation
function wrapToolResult(tool: string, count: number, content: string): string {
	const status = count > 0 ? `Found ${count} item${count === 1 ? "" : "s"}` : "No items found";
	return `<veil-${tool} count="${count}">\n${status}:\n${content}\n</veil-${tool}>`;
}
