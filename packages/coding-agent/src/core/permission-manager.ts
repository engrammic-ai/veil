/**
 * Permission mode management for tool execution approval.
 *
 * Modes:
 * - plan: Read-only, block all write operations
 * - default: Prompt for dangerous tools
 * - auto-accept-edits: Auto-approve edits in working directory
 * - auto: Most permissive, auto-approve most tools
 *
 * Config loaded from .veil/permissions.jsonc or ~/.config/veil/permissions.jsonc
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

export type PermissionMode = "plan" | "default" | "auto-accept-edits" | "auto";

const PERMISSION_MODES: PermissionMode[] = ["plan", "default", "auto-accept-edits", "auto"];

// Tools that modify state
const WRITE_TOOLS = new Set(["bash", "write", "edit", "notebook_edit", "mcp_tool"]);

// Tools that only read
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "list_directory", "search", "web_search", "web_fetch"]);

// Default protected paths that always prompt regardless of mode
const DEFAULT_PROTECTED_PATHS = [
	".git",
	".claude",
	".veil",
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"**/secrets/**",
	"**/.ssh/**",
	"~/.bashrc",
	"~/.zshrc",
	"~/.profile",
	"~/.bash_profile",
];

export interface PermissionConfig {
	// Default mode on startup
	defaultMode?: PermissionMode;

	// Tools to always allow (skip prompting)
	allowList?: string[];

	// Tools to always prompt for (even in auto mode)
	denyList?: string[];

	// Paths that always require prompting
	protectedPaths?: string[];

	// Bash command patterns to allow
	bashAllow?: string[];

	// Bash command patterns to deny
	bashDeny?: string[];
}

export interface ToolCallContext {
	toolName: string;
	args?: Record<string, unknown>;
	workingDir?: string;
}

function expandHomePath(path: string): string {
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

function matchesGlobPattern(path: string, pattern: string): boolean {
	const expandedPattern = expandHomePath(pattern);

	// Simple glob matching
	if (expandedPattern.includes("**")) {
		// ** matches any number of directories
		const parts = expandedPattern.split("**");
		if (parts.length === 2) {
			const [prefix, suffix] = parts;
			const normalizedPath = path.replace(/\\/g, "/");
			const normalizedPrefix = prefix.replace(/\\/g, "/");
			const normalizedSuffix = suffix.replace(/\\/g, "/");

			if (normalizedPrefix && !normalizedPath.startsWith(normalizedPrefix)) {
				return false;
			}
			if (normalizedSuffix && !normalizedPath.endsWith(normalizedSuffix)) {
				return false;
			}
			return true;
		}
	}

	if (expandedPattern.includes("*")) {
		// Single * matches anything except /
		const regex = new RegExp(
			"^" +
				expandedPattern
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, "[^/]*")
					.replace(/\?/g, "[^/]") +
				"$",
		);
		return regex.test(path);
	}

	// Exact match or path contains pattern
	return path === expandedPattern || path.includes(expandedPattern);
}

function matchesBashPattern(command: string, pattern: string): boolean {
	// Convert bash pattern to regex
	// * matches anything
	const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
	return regex.test(command);
}

function loadConfig(cwd: string): PermissionConfig {
	const configPaths = [
		join(cwd, ".veil", "permissions.jsonc"),
		join(cwd, ".veil", "permissions.json"),
		join(homedir(), ".config", "veil", "permissions.jsonc"),
		join(homedir(), ".config", "veil", "permissions.json"),
	];

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf8");
				// Strip JSONC comments
				const jsonContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
				return JSON.parse(jsonContent) as PermissionConfig;
			} catch {
				// Invalid config, continue to next
			}
		}
	}

	return {};
}

export class PermissionManager {
	private mode: PermissionMode = "default";
	private config: PermissionConfig = {};
	private sessionAllowed = new Set<string>();
	private sessionDenied = new Set<string>();
	private listeners = new Set<(mode: PermissionMode) => void>();
	private workingDir: string;

	constructor(workingDir?: string) {
		this.workingDir = workingDir ?? process.cwd();
		this.config = loadConfig(this.workingDir);
		if (this.config.defaultMode && PERMISSION_MODES.includes(this.config.defaultMode)) {
			this.mode = this.config.defaultMode;
		}
	}

	getMode(): PermissionMode {
		return this.mode;
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
		this.notifyListeners();
	}

	cycleMode(): PermissionMode {
		const idx = PERMISSION_MODES.indexOf(this.mode);
		const nextIdx = (idx + 1) % PERMISSION_MODES.length;
		this.mode = PERMISSION_MODES[nextIdx];
		this.notifyListeners();
		return this.mode;
	}

	getConfig(): Readonly<PermissionConfig> {
		return this.config;
	}

	reloadConfig(): void {
		this.config = loadConfig(this.workingDir);
	}

	setWorkingDir(dir: string): void {
		this.workingDir = dir;
		this.reloadConfig();
	}

	/**
	 * Determine if we should prompt the user before executing a tool.
	 */
	shouldPrompt(ctx: ToolCallContext): boolean {
		const { toolName, args } = ctx;

		// Session-level overrides first
		if (this.sessionAllowed.has(toolName)) {
			return false;
		}
		if (this.sessionDenied.has(toolName)) {
			return true;
		}

		// Check config deny list (always prompt)
		if (this.config.denyList?.includes(toolName)) {
			return true;
		}

		// Check config allow list (never prompt)
		if (this.config.allowList?.includes(toolName)) {
			return false;
		}

		// Check protected paths for file operations
		if (this.isProtectedPathAccess(toolName, args)) {
			return true;
		}

		// Check bash command patterns
		if (toolName === "bash" && args?.command) {
			const command = String(args.command);

			// Check bash deny patterns
			if (this.config.bashDeny?.some((pattern) => matchesBashPattern(command, pattern))) {
				return true;
			}

			// Check bash allow patterns
			if (this.config.bashAllow?.some((pattern) => matchesBashPattern(command, pattern))) {
				return false;
			}
		}

		// Mode-specific logic
		return this.shouldPromptForMode(toolName, args);
	}

	private shouldPromptForMode(toolName: string, args?: Record<string, unknown>): boolean {
		switch (this.mode) {
			case "plan":
				// Read-only mode: prompt for any write operation
				return WRITE_TOOLS.has(toolName) || toolName.startsWith("mcp__");

			case "default":
				// Prompt for dangerous tools
				return WRITE_TOOLS.has(toolName) || toolName.startsWith("mcp__");

			case "auto-accept-edits":
				// Auto-approve edits within working directory
				if (READ_ONLY_TOOLS.has(toolName)) {
					return false;
				}
				if (WRITE_TOOLS.has(toolName)) {
					return !this.isWithinWorkingDir(toolName, args);
				}
				// MCP tools still prompt
				return toolName.startsWith("mcp__");

			case "auto":
				// Most permissive: only prompt for MCP tools by default
				return toolName.startsWith("mcp__");

			default:
				return true;
		}
	}

	private isWithinWorkingDir(toolName: string, args?: Record<string, unknown>): boolean {
		if (!args) return false;

		// Extract path from various tool argument shapes
		let targetPath: string | undefined;

		if (toolName === "write" || toolName === "edit" || toolName === "read") {
			targetPath = args.file_path as string | undefined;
		} else if (toolName === "bash") {
			// For bash, we can't easily determine the target path
			// Be conservative and check if command seems to operate on cwd
			const command = String(args.command ?? "");
			// If command doesn't use absolute paths or .., assume it's in working dir
			if (!command.includes("/") || command.startsWith("./")) {
				return true;
			}
			return false;
		}

		if (!targetPath) return false;

		const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(this.workingDir, targetPath);
		const normalizedTarget = resolve(absoluteTarget);
		const normalizedWorkingDir = resolve(this.workingDir);

		return normalizedTarget.startsWith(normalizedWorkingDir + "/") || normalizedTarget === normalizedWorkingDir;
	}

	private isProtectedPathAccess(toolName: string, args?: Record<string, unknown>): boolean {
		if (!args) return false;

		// Get the file path from args
		let targetPath: string | undefined;

		if (toolName === "write" || toolName === "edit" || toolName === "read") {
			targetPath = args.file_path as string | undefined;
		} else if (toolName === "bash") {
			// For bash, check the command for protected paths
			const command = String(args.command ?? "");
			const protectedPaths = [...DEFAULT_PROTECTED_PATHS, ...(this.config.protectedPaths ?? [])];

			for (const pattern of protectedPaths) {
				const expanded = expandHomePath(pattern);
				if (command.includes(expanded) || matchesGlobPattern(command, pattern)) {
					return true;
				}
			}
			return false;
		}

		if (!targetPath) return false;

		const protectedPaths = [...DEFAULT_PROTECTED_PATHS, ...(this.config.protectedPaths ?? [])];

		for (const pattern of protectedPaths) {
			if (matchesGlobPattern(targetPath, pattern)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Block a tool entirely for this session (plan mode uses this).
	 */
	shouldBlock(ctx: ToolCallContext): { block: boolean; reason?: string } {
		if (this.mode === "plan" && WRITE_TOOLS.has(ctx.toolName)) {
			return {
				block: true,
				reason: `Tool "${ctx.toolName}" blocked: plan mode is read-only`,
			};
		}
		return { block: false };
	}

	allowForSession(toolName: string): void {
		this.sessionAllowed.add(toolName);
		this.sessionDenied.delete(toolName);
	}

	denyForSession(toolName: string): void {
		this.sessionDenied.add(toolName);
		this.sessionAllowed.delete(toolName);
	}

	resetSessionOverrides(): void {
		this.sessionAllowed.clear();
		this.sessionDenied.clear();
	}

	onModeChange(listener: (mode: PermissionMode) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			listener(this.mode);
		}
	}

	/**
	 * Get a human-readable description of the current mode.
	 */
	getModeDescription(): string {
		switch (this.mode) {
			case "plan":
				return "Read-only mode - write operations blocked";
			case "default":
				return "Prompts for dangerous tools";
			case "auto-accept-edits":
				return "Auto-approves edits in working directory";
			case "auto":
				return "Auto-approves most tools";
			default:
				return this.mode;
		}
	}
}
