/**
 * MCP (Model Context Protocol) integration types.
 */

export interface McpServerConfig {
	/** Command to spawn the MCP server */
	command: string;
	/** Arguments to pass to the command */
	args?: string[];
	/** Environment variables for the server process */
	env?: Record<string, string>;
	/** Working directory for the server */
	cwd?: string;
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
}

export interface McpConfig {
	/** MCP servers keyed by name */
	mcpServers?: Record<string, McpServerConfig>;
	/** Global MCP settings */
	settings?: {
		/** Whether MCP is enabled globally (default: true) */
		enabled?: boolean;
		/** Connection timeout in ms (default: 30000) */
		connectionTimeout?: number;
	};
}

export interface McpToolInfo {
	/** Tool name */
	name: string;
	/** Tool description */
	description?: string;
	/** JSON Schema for input */
	inputSchema: Record<string, unknown>;
	/** Server this tool belongs to */
	serverName: string;
}

export interface McpToolResult {
	content: Array<{
		type: "text" | "image" | "resource";
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	isError?: boolean;
}
