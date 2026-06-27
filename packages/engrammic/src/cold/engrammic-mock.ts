/**
 * MockEngrammicServer - simulates the engrammic MCP server for testing.
 * Not for production use.
 */

interface MockNode {
	node_id: string;
	node_type: "Memory" | "Claim";
	content: string;
	tags: string[];
	confidence: number;
	created_at: string;
}

export interface ConflictInfo {
	conflict_id: string;
	node_ids: string[];
	description: string;
	severity: "low" | "medium" | "high";
}

interface ConflictsResponse {
	conflicts: ConflictInfo[];
}

export type McpExecutor = (tool: string, params: Record<string, unknown>) => Promise<unknown>;

export class MockEngrammicServer {
	private nodes = new Map<string, MockNode>();
	private conflicts: ConflictsResponse["conflicts"] = [];
	private shouldFail = false;
	private failureType: "network" | "rate_limit" | "auth" = "network";

	setFailure(enabled: boolean, type?: "network" | "rate_limit" | "auth"): void {
		this.shouldFail = enabled;
		this.failureType = type ?? "network";
	}

	addNode(node: MockNode): void {
		this.nodes.set(node.node_id, node);
	}

	addConflict(conflict: ConflictsResponse["conflicts"][0]): void {
		this.conflicts.push(conflict);
	}

	createExecutor(): McpExecutor {
		return async (tool: string, params: Record<string, unknown>) => {
			if (this.shouldFail) {
				throw this.makeError();
			}
			const toolName = tool.replace(/^mcp__\w+__/, "");
			return this.handleTool(toolName, params);
		};
	}

	private makeError(): Error {
		switch (this.failureType) {
			case "rate_limit":
				return new Error("429 Too Many Requests");
			case "auth":
				return new Error("401 Unauthorized");
			default:
				return new Error("Network error");
		}
	}

	private handleTool(tool: string, params: Record<string, unknown>): unknown {
		switch (tool) {
			case "remember":
				return this.handleRemember(params);
			case "learn":
				return this.handleLearn(params);
			case "recall":
				return this.handleRecall(params);
			case "forget":
				return this.handleForget(params);
			case "conflicts":
				return { conflicts: this.conflicts };
			case "tick":
				return { pending: [] };
			case "introspect":
				return { node_count: this.nodes.size };
			case "trace":
				return this.handleTrace(params);
			default:
				throw new Error(`Unknown tool: ${tool}`);
		}
	}

	private handleRemember(params: Record<string, unknown>): { node_id: string } {
		const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.nodes.set(id, {
			node_id: id,
			node_type: "Memory",
			content: params.content as string,
			tags: (params.tags as string[]) ?? [],
			confidence: 0.8,
			created_at: new Date().toISOString(),
		});
		return { node_id: id };
	}

	private handleLearn(params: Record<string, unknown>): { node_id: string } {
		const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		this.nodes.set(id, {
			node_id: id,
			node_type: "Claim",
			content: params.content as string,
			tags: (params.tags as string[]) ?? [],
			confidence: (params.confidence as number) ?? 0.9,
			created_at: new Date().toISOString(),
		});
		return { node_id: id };
	}

	private handleRecall(params: Record<string, unknown>): { nodes: MockNode[] } {
		const nodeIds = params.node_ids as string[] | undefined;
		const query = params.query as string | undefined;
		const tags = params.tags as string[] | undefined;
		const topK = (params.top_k as number) ?? 10;

		let results: MockNode[];

		if (nodeIds) {
			results = nodeIds.map((id) => this.nodes.get(id)).filter((n): n is MockNode => n !== undefined);
		} else if (query) {
			results = [...this.nodes.values()]
				.filter((n) => n.content.toLowerCase().includes(query.toLowerCase()))
				.slice(0, topK);
		} else {
			results = [...this.nodes.values()].slice(0, topK);
		}

		if (tags?.length) {
			results = results.filter((n) => tags.some((t) => n.tags.includes(t)));
		}

		return { nodes: results };
	}

	private handleForget(params: Record<string, unknown>): void {
		this.nodes.delete(params.node_id as string);
	}

	private handleTrace(params: Record<string, unknown>): { chain: MockNode[] } {
		const nodeId = params.node_id as string | undefined;
		if (!nodeId) return { chain: [] };
		const node = this.nodes.get(nodeId);
		return { chain: node ? [node] : [] };
	}

	// Utility for testing
	size(): number {
		return this.nodes.size;
	}
}
