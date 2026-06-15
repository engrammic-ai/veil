/**
 * MCP Extension for Veil/Pi
 *
 * Bridges MCP (Model Context Protocol) servers to Pi's extension system.
 * Loads config from ~/.veil/mcp.json and registers MCP tools as Pi tools.
 *
 * Toggle via settings: { "mcp": { "enabled": true } } in ~/.veil/settings.json
 * or via CLI: --mcp / --no-mcp
 */

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "../../index.ts";
import { McpClientManager } from "./client-manager.ts";
import { loadMcpConfig } from "./config.ts";
import type { McpToolInfo } from "./types.ts";

let manager: McpClientManager | null = null;

/**
 * Convert MCP JSON Schema to TypeBox schema.
 * Falls back to Type.Unknown() for complex schemas.
 */
function mcpSchemaToTypebox(inputSchema: Record<string, unknown>): ReturnType<typeof Type.Object> {
	const properties = (inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
	const required = (inputSchema.required ?? []) as string[];

	const typeboxProps: Record<string, ReturnType<typeof Type.String | typeof Type.Number | typeof Type.Boolean | typeof Type.Unknown>> = {};

	for (const [key, prop] of Object.entries(properties)) {
		const desc = prop.description ? { description: prop.description } : {};
		const isOptional = !required.includes(key);

		let typeDef;
		switch (prop.type) {
			case "string":
				typeDef = Type.String(desc);
				break;
			case "number":
			case "integer":
				typeDef = Type.Number(desc);
				break;
			case "boolean":
				typeDef = Type.Boolean(desc);
				break;
			default:
				typeDef = Type.Unknown(desc);
		}

		typeboxProps[key] = isOptional ? Type.Optional(typeDef) : typeDef;
	}

	return Type.Object(typeboxProps);
}

/**
 * Register a single MCP tool as a Pi tool.
 */
function registerMcpTool(pi: ExtensionAPI, tool: McpToolInfo): void {
	const fullName = `mcp__${tool.serverName}__${tool.name}`;

	pi.registerTool({
		name: fullName,
		label: `${tool.serverName}/${tool.name}`,
		description: tool.description ?? `MCP tool from ${tool.serverName}`,
		parameters: mcpSchemaToTypebox(tool.inputSchema),
		async execute(_toolCallId, params) {
			const details = { server: tool.serverName, tool: tool.name };

			if (!manager) {
				return {
					content: [{ type: "text", text: "MCP manager not initialized" }],
					isError: true,
					details,
				};
			}

			try {
				const result = await manager.callTool(tool.serverName, tool.name, params as Record<string, unknown>);

				const textContent = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text", text: textContent || "(empty response)" }],
					isError: result.isError,
					details,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `MCP error: ${err}` }],
					isError: true,
					details,
				};
			}
		},
	});
}

export default function mcpExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const config = loadMcpConfig();

		if (!config.settings?.enabled) {
			return;
		}

		if (Object.keys(config.mcpServers ?? {}).length === 0) {
			return;
		}

		manager = new McpClientManager(config);

		try {
			const { serverCount, toolCount, errors } = await manager.connectAll();

			if (serverCount > 0) {
				ctx.ui.notify(`MCP: ${serverCount} server(s), ${toolCount} tool(s)`, "info");

				for (const tool of manager.getAllTools()) {
					registerMcpTool(pi, tool);
				}
			}

			if (errors.length > 0) {
				ctx.ui.notify(`MCP: ${errors.length} connection error(s)`, "warning");
			}
		} catch (err) {
			ctx.ui.notify(`MCP init failed: ${err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (manager) {
			await manager.disconnectAll();
			manager = null;
		}
	});

	pi.registerCommand("mcp", {
		description: "Manage MCP servers: /mcp [status|reconnect|list|help]",
		handler: async (args, ctx) => {
			const subcommand = args.trim().split(/\s+/)[0] || "status";

			switch (subcommand) {
				case "help":
					ctx.ui.notify(
						[
							"MCP Commands:",
							"  /mcp              Show server status (default)",
							"  /mcp status       Show connected servers and tool count",
							"  /mcp list         List all available tools",
							"  /mcp reconnect    Disconnect and reconnect all servers",
							"  /mcp help         Show this help",
							"",
							"Config: ~/.veil/mcp.json",
							"Disable: --no-mcp flag",
						].join("\n"),
						"info",
					);
					break;

				case "list":
					if (!manager) {
						ctx.ui.notify("MCP not initialized", "info");
						return;
					}
					const tools = manager.getAllTools();
					if (tools.length === 0) {
						ctx.ui.notify("No MCP tools available", "info");
						return;
					}
					const byServer = new Map<string, McpToolInfo[]>();
					for (const t of tools) {
						const list = byServer.get(t.serverName) ?? [];
						list.push(t);
						byServer.set(t.serverName, list);
					}
					const lines: string[] = [];
					for (const [server, serverTools] of byServer) {
						lines.push(`[${server}] (${serverTools.length} tools)`);
						for (const t of serverTools) {
							lines.push(`  - ${t.name}: ${t.description ?? "(no description)"}`);
						}
					}
					ctx.ui.notify(lines.join("\n"), "info");
					break;

				case "reconnect":
					const config = loadMcpConfig();
					if (manager) {
						await manager.disconnectAll();
					}
					manager = new McpClientManager(config);
					try {
						const { serverCount, toolCount } = await manager.connectAll();
						ctx.ui.notify(`MCP reconnected: ${serverCount} server(s), ${toolCount} tool(s)`, "info");
						for (const tool of manager.getAllTools()) {
							registerMcpTool(pi, tool);
						}
					} catch (err) {
						ctx.ui.notify(`MCP reconnect failed: ${err}`, "error");
					}
					break;

				case "status":
				default:
					if (!manager) {
						ctx.ui.notify("MCP not initialized (no mcp.json or disabled)", "info");
						return;
					}
					const servers = manager.getConnectedServers();
					const allTools = manager.getAllTools();
					if (servers.length === 0) {
						ctx.ui.notify("No MCP servers connected\nConfig: ~/.veil/mcp.json", "info");
						return;
					}
					ctx.ui.notify(
						[
							`MCP Status:`,
							`  Servers: ${servers.join(", ")}`,
							`  Tools: ${allTools.length}`,
							"",
							"Use /mcp list to see all tools",
							"Use /mcp reconnect to reload",
						].join("\n"),
						"info",
					);
					break;
			}
		},
	});
}
