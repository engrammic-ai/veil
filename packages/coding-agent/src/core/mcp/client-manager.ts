/**
 * MCP client manager.
 *
 * Manages connections to MCP servers, spawning them via stdio transport.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig, McpServerConfig, McpToolInfo, McpToolResult } from "./types.ts";
import { getEnabledServers } from "./config.ts";

interface ConnectedServer {
	client: Client;
	transport: StdioClientTransport;
	tools: McpToolInfo[];
}

export class McpClientManager {
	private servers: Map<string, ConnectedServer> = new Map();
	private config: McpConfig;
	private connectionTimeout: number;

	constructor(config: McpConfig) {
		this.config = config;
		this.connectionTimeout = config.settings?.connectionTimeout ?? 30000;
	}

	/**
	 * Connect to all enabled MCP servers.
	 * Returns the total number of tools discovered.
	 */
	async connectAll(): Promise<{ serverCount: number; toolCount: number; errors: string[] }> {
		const enabledServers = getEnabledServers(this.config);
		const errors: string[] = [];
		let toolCount = 0;

		for (const [name, serverConfig] of Object.entries(enabledServers)) {
			try {
				const tools = await this.connect(name, serverConfig);
				toolCount += tools.length;
			} catch (err) {
				const msg = `[mcp] Failed to connect to ${name}: ${err}`;
				errors.push(msg);
				console.error(msg);
			}
		}

		return {
			serverCount: this.servers.size,
			toolCount,
			errors,
		};
	}

	/**
	 * Connect to a single MCP server.
	 */
	async connect(name: string, config: McpServerConfig): Promise<McpToolInfo[]> {
		if (this.servers.has(name)) {
			return this.servers.get(name)!.tools;
		}

		// Filter out undefined env values
		const env = config.env
			? Object.fromEntries(
					Object.entries({ ...process.env, ...config.env }).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				)
			: undefined;

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env,
			cwd: config.cwd,
		});

		const client = new Client(
			{ name: "veil", version: "1.0.0" },
			{ capabilities: {} },
		);

		await Promise.race([
			client.connect(transport),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Connection timeout")), this.connectionTimeout),
			),
		]);

		const toolsResult = await client.listTools();
		const tools: McpToolInfo[] = (toolsResult.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema as Record<string, unknown>,
			serverName: name,
		}));

		this.servers.set(name, { client, transport, tools });

		return tools;
	}

	/**
	 * Get all tools from all connected servers.
	 */
	getAllTools(): McpToolInfo[] {
		const tools: McpToolInfo[] = [];
		for (const server of this.servers.values()) {
			tools.push(...server.tools);
		}
		return tools;
	}

	/**
	 * Call a tool on an MCP server.
	 */
	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const server = this.servers.get(serverName);
		if (!server) {
			throw new Error(`MCP server "${serverName}" not connected`);
		}

		const result = await server.client.callTool({ name: toolName, arguments: args });

		const contentArray = Array.isArray(result.content)
			? result.content
			: [];

		return {
			content: contentArray.map((c: { type: string; text?: string; data?: string; mimeType?: string }) => {
				if (c.type === "text") {
					return { type: "text" as const, text: c.text };
				}
				if (c.type === "image") {
					return { type: "image" as const, data: c.data, mimeType: c.mimeType };
				}
				return { type: "resource" as const, text: JSON.stringify(c) };
			}),
			isError: result.isError === true,
		};
	}

	/**
	 * Disconnect from all MCP servers.
	 */
	async disconnectAll(): Promise<void> {
		for (const [name, server] of this.servers) {
			try {
				await server.client.close();
			} catch (err) {
				console.error(`[mcp] Error disconnecting from ${name}:`, err);
			}
		}
		this.servers.clear();
	}

	/**
	 * Check if MCP is enabled and has any servers configured.
	 */
	isEnabled(): boolean {
		return (
			this.config.settings?.enabled !== false &&
			Object.keys(this.config.mcpServers ?? {}).length > 0
		);
	}

	/**
	 * Get connected server names.
	 */
	getConnectedServers(): string[] {
		return Array.from(this.servers.keys());
	}
}
