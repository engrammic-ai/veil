/**
 * Factory for creating McpExecutor from the coding-agent's MCP client manager.
 *
 * McpExecutor is the injection point used by EngrammicColdStore (in @engrammic/veil-context)
 * to make MCP tool calls without depending directly on coding-agent's MCP infrastructure.
 *
 * McpToolResult.content[0].text holds JSON-encoded domain responses, which we parse
 * here so callers receive plain objects (matching engrammic's cast patterns).
 */

import type { McpExecutor } from "@engrammic/veil-context";

/** Structural interface for MCP tool callers — satisfied by McpClientManager. */
interface McpCallable {
	callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

export function createMcpExecutor(manager: McpCallable, serverName: string = "engrammic"): McpExecutor {
	return async (tool: string, params: Record<string, unknown>) => {
		// tool arrives as "mcp__<serverName>__<toolName>" — strip the prefix
		const toolName = tool.replace(`mcp__${serverName}__`, "");
		const result = await manager.callTool(serverName, toolName, params);

		if (result.isError) {
			const errText = result.content.find((c) => c.type === "text")?.text ?? "MCP tool error";
			throw new Error(`[mcp:${serverName}:${toolName}] ${errText}`);
		}

		const textContent = result.content.find((c) => c.type === "text")?.text;
		if (textContent === undefined) {
			return undefined;
		}

		try {
			return JSON.parse(textContent);
		} catch {
			return textContent;
		}
	};
}
