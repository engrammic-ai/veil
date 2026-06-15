/**
 * MCP configuration loader.
 *
 * Loads MCP server configs from ~/.veil/mcp.json (or piConfig.configDir).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpConfig, McpServerConfig } from "./types.ts";

const DEFAULT_CONFIG: McpConfig = {
	mcpServers: {},
	settings: {
		enabled: true,
		connectionTimeout: 30000,
	},
};

/**
 * Load MCP configuration from the user's config directory.
 *
 * Looks for mcp.json in:
 * 1. ~/.veil/mcp.json (default)
 * 2. Path specified by configDir parameter
 *
 * Returns default config if file doesn't exist.
 */
export function loadMcpConfig(configDir?: string): McpConfig {
	const dir = configDir ?? join(homedir(), ".veil");
	const configPath = join(dir, "mcp.json");

	if (!existsSync(configPath)) {
		return DEFAULT_CONFIG;
	}

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as McpConfig;

		return {
			mcpServers: parsed.mcpServers ?? {},
			settings: {
				...DEFAULT_CONFIG.settings,
				...parsed.settings,
			},
		};
	} catch (err) {
		console.error(`[mcp] Failed to parse ${configPath}:`, err);
		return DEFAULT_CONFIG;
	}
}

/**
 * Get enabled MCP servers from config.
 */
export function getEnabledServers(config: McpConfig): Record<string, McpServerConfig> {
	if (!config.settings?.enabled) {
		return {};
	}

	const result: Record<string, McpServerConfig> = {};

	for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
		if (server.enabled !== false) {
			result[name] = server;
		}
	}

	return result;
}
