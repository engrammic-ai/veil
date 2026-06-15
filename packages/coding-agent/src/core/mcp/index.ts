/**
 * MCP (Model Context Protocol) integration for Veil.
 *
 * Enables Veil to connect to MCP servers and expose their tools.
 *
 * Configuration: ~/.veil/mcp.json
 * ```json
 * {
 *   "mcpServers": {
 *     "engrammic": {
 *       "command": "npx",
 *       "args": ["engrammic-mcp"]
 *     }
 *   },
 *   "settings": {
 *     "enabled": true
 *   }
 * }
 * ```
 */

export { McpClientManager } from "./client-manager.ts";
export { getEnabledServers, loadMcpConfig } from "./config.ts";
export { default as mcpExtension } from "./extension.ts";
export type { McpConfig, McpServerConfig, McpToolInfo, McpToolResult } from "./types.ts";
