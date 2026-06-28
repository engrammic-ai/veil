/**
 * EngrammicColdStore - ColdStore adapter that routes cold storage to the engrammic MCP server.
 *
 * Enables cross-project, cross-device memory via engrammic's knowledge graph.
 * McpExecutor must be injected by the harness (coding-agent has MCP access, engrammic package does not).
 */

import { createHash } from "node:crypto";
import type { ContextItem } from "../types.ts";
import type { ColdStore, ColdStoreCapabilities, ColdStoreConfig } from "./interface.ts";

export type McpExecutor = (tool: string, params: Record<string, unknown>) => Promise<unknown>;

// --- Public types ---

export interface EngrammicColdStoreConfig extends ColdStoreConfig {
	/** MCP server name. Defaults to "engrammic". For claude.ai hosted: "claude_ai_engrammic" */
	mcpServerName?: string;
	/** Silo ID for multi-tenant setups. Defaults to org's primary silo. */
	siloId?: string;
	/** Project identifier for namespacing. Defaults to hash of cwd. */
	projectId?: string;
	/** Tag items with projectId for filtering. Default: true. */
	tagWithProject?: boolean;
	/** Decay policy for remembered items. Default: "durable". */
	defaultDecay?: "ephemeral" | "standard" | "durable" | "permanent";
	/** MCP tool executor. Injected by harness. */
	mcpExecutor: McpExecutor;
}

export interface ConflictInfo {
	conflictId: string;
	nodeA: { id: string; content: string; agentId: string };
	nodeB: { id: string; content: string; agentId: string };
	status: "unresolved" | "escalated";
}

export interface TraceResult {
	nodeId: string;
	chain: Array<{ id: string; content: string; edge: string }>;
}

export class EngrammicUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngrammicUnavailableError";
	}
}

// --- Internal types ---

interface EngrammicNode {
	node_id: string;
	node_type: "Memory" | "Claim" | "Belief" | "Commitment";
	content: string;
	confidence?: number;
	created_at: string;
	last_accessed_at?: string;
	tags?: string[];
	lifecycle_state?: "active" | "superseded" | "tombstoned";
	superseded_by?: string;
}

interface ContributionsResponse {
	agent_id: string;
	node_count: number;
	first_seen: string;
	last_seen: string;
}

interface ConflictsResponse {
	conflicts: Array<{
		edge_id: string;
		node_a: { node_id: string; content: string; agent_id: string };
		node_b: { node_id: string; content: string; agent_id: string };
		resolution_status: "unresolved" | "escalated" | "resolved" | "dismissed";
	}>;
}

interface TraceResponse {
	chain: Array<{ node_id: string; content: string; edge_type: string }>;
}

// ---

export class EngrammicColdStore implements ColdStore {
	readonly capabilities: ColdStoreCapabilities = {
		semantic: true,
		temporal: true,
		provenance: true,
		glob: false, // TODO: implement list() with MCP list_mode
		listing: false,
		entityResolution: false,
	};

	private readonly executor: McpExecutor;
	private readonly serverName: string;
	private readonly projectId: string;
	private readonly tagWithProject: boolean;
	private readonly defaultDecay: string;

	// Circuit breaker state
	private available = true;
	private lastCheck = 0;
	private checkInterval = 60_000;

	constructor(config: EngrammicColdStoreConfig) {
		this.executor = config.mcpExecutor;
		this.serverName = config.mcpServerName ?? "engrammic";
		this.projectId = config.projectId ?? config.namespace ?? deriveProjectId();
		this.tagWithProject = config.tagWithProject ?? true;
		this.defaultDecay = config.defaultDecay ?? "durable";
	}

	async demote(item: ContextItem): Promise<string> {
		const tags = [...item.tags, ...(this.tagWithProject ? [`project:${this.projectId}`] : [])];

		if (item.type === "fact") {
			const result = (await this.mcp("learn", {
				claim: item.content,
				evidence: [],
				source: this.mapSource(item.source),
				tags,
				confidence: this.mapCognitiveWeight(item.cognitiveWeight),
			})) as { node_id: string };
			return result.node_id;
		}

		const result = (await this.mcp("remember", {
			content: item.content,
			tags,
			decay: this.defaultDecay,
			memory_type: this.mapItemType(item.type),
		})) as { node_id: string };
		return result.node_id;
	}

	async fetch(pointer: string): Promise<ContextItem | null> {
		const result = (await this.mcp("recall", {
			node_ids: [pointer],
			include_content: true,
		})) as { nodes?: EngrammicNode[] };

		if (!result.nodes?.length) return null;
		return this.nodeToContextItem(result.nodes[0], pointer);
	}

	async delete(pointer: string): Promise<void> {
		await this.mcp("forget", {
			node_id: pointer,
			reason: "Deleted via Veil context management",
		});
	}

	async exists(pointer: string): Promise<boolean> {
		try {
			const result = (await this.mcp("recall", {
				node_ids: [pointer],
				include_content: false,
			})) as { nodes?: EngrammicNode[] };
			return (result.nodes?.length ?? 0) > 0;
		} catch {
			return false;
		}
	}

	async count(): Promise<number> {
		try {
			const result = (await this.mcp("introspect", {
				query_type: "contributions",
			})) as ContributionsResponse;
			return result.node_count ?? 0;
		} catch {
			return 0;
		}
	}

	/** Lightweight connection check using the spec-mandated tick tool. Throws on failure. */
	async probe(): Promise<void> {
		await this.mcp("tick", {});
	}

	async query(
		text: string,
		tags: string[],
		limit: number,
		options?: { scope?: "project" | "global" },
	): Promise<ContextItem[]> {
		const queryTags =
			options?.scope === "project" && this.tagWithProject ? [...tags, `project:${this.projectId}`] : tags;

		const result = (await this.mcp("recall", {
			query: text,
			top_k: limit,
			tags: queryTags.length > 0 ? queryTags : undefined,
		})) as { nodes?: EngrammicNode[] };

		if (!result.nodes?.length) return [];
		return result.nodes.map((n) => this.nodeToContextItem(n, n.node_id));
	}

	async close(): Promise<void> {
		// No persistent connection to engrammic MCP to close.
	}

	// --- Engrammic-specific methods ---

	async conflicts(limit: number = 50): Promise<ConflictInfo[]> {
		const result = (await this.mcp("conflicts", {
			status: "unresolved",
			limit,
		})) as ConflictsResponse;

		return (result.conflicts ?? [])
			.filter((c) => c.resolution_status === "unresolved" || c.resolution_status === "escalated")
			.map((c) => ({
				conflictId: c.edge_id,
				nodeA: { id: c.node_a.node_id, content: c.node_a.content, agentId: c.node_a.agent_id },
				nodeB: { id: c.node_b.node_id, content: c.node_b.content, agentId: c.node_b.agent_id },
				status: c.resolution_status as "unresolved" | "escalated",
			}));
	}

	async trace(nodeId: string, direction?: "up" | "down"): Promise<TraceResult> {
		const result = (await this.mcp("trace", {
			node_id: nodeId,
			...(direction ? { direction } : {}),
		})) as TraceResponse;

		return {
			nodeId,
			chain: (result.chain ?? []).map((entry) => ({
				id: entry.node_id,
				content: entry.content,
				edge: entry.edge_type,
			})),
		};
	}

	async resolveConflict(conflictId: string, winnerId: string): Promise<void> {
		await this.mcp("resolve_conflict", {
			conflict_id: conflictId,
			winner_node_id: winnerId,
		});
	}

	async dismissConflict(conflictId: string, reason?: string): Promise<void> {
		await this.mcp("dismiss_conflict", {
			conflict_id: conflictId,
			...(reason ? { reason } : {}),
		});
	}

	// --- Circuit breaker ---

	private async mcp(tool: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this.available && Date.now() - this.lastCheck < this.checkInterval) {
			throw new EngrammicUnavailableError("Engrammic MCP unavailable (circuit open)");
		}

		try {
			const result = await this.executor(`mcp__${this.serverName}__${tool}`, params);
			this.available = true;
			this.checkInterval = 60_000;
			return result;
		} catch (err) {
			this.handleError(err);
			throw err;
		}
	}

	private handleError(err: unknown): void {
		this.available = false;
		this.lastCheck = Date.now();

		if (this.isRateLimitError(err)) {
			this.checkInterval = Math.min(this.checkInterval * 2, 300_000);
		} else if (this.isAuthError(err)) {
			this.checkInterval = 300_000;
		} else {
			this.checkInterval = 60_000;
		}
	}

	private isRateLimitError(err: unknown): boolean {
		return err instanceof Error && (err.message.includes("429") || err.message.includes("rate limit"));
	}

	private isAuthError(err: unknown): boolean {
		return (
			err instanceof Error &&
			(err.message.includes("401") || err.message.includes("403") || err.message.includes("unauthorized"))
		);
	}

	// --- Type mapping helpers ---

	private mapItemType(type: ContextItem["type"]): string {
		switch (type) {
			case "episodic":
				return "observation";
			case "procedural":
				return "event";
			default:
				return "observation";
		}
	}

	private mapSource(source: ContextItem["source"]): string {
		switch (source) {
			case "explicit":
				return "user";
			case "auto":
				return "agent";
			default:
				return "agent";
		}
	}

	private mapNodeType(nodeType: EngrammicNode["node_type"]): ContextItem["type"] {
		switch (nodeType) {
			case "Claim":
				return "fact";
			case "Memory":
				return "episodic";
			default:
				return "episodic";
		}
	}

	private mapCognitiveWeight(weight: number): number {
		// cognitiveWeight is -1 to +1; confidence is 0 to 1
		return (weight + 1) / 2;
	}

	private hash(content: string): string {
		return createHash("sha256").update(content).digest("hex").slice(0, 16);
	}

	private nodeToContextItem(node: EngrammicNode, pointer: string): ContextItem {
		const content = node.content;
		const createdAt = Date.parse(node.created_at);
		const lastAccess = Date.parse(node.last_accessed_at ?? node.created_at);
		const confidence = node.confidence ?? 0.5;

		return {
			id: pointer,
			content,
			contentHash: this.hash(content),
			createdAt,
			lastAccess,
			accessCount: 1,
			usedCount: 0,
			ignoredCount: 0,
			decayScore: confidence,
			cognitiveWeight: confidence * 2 - 1, // 0-1 → -1 to +1
			stability: 1,
			difficulty: 0.5,
			type: this.mapNodeType(node.node_type),
			tags: node.tags ?? [],
			pinned: false,
			kgPointer: pointer,
			source: "auto",
		};
	}
}

function deriveProjectId(cwd: string = process.cwd()): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}
