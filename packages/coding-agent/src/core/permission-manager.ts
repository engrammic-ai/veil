/**
 * Permission mode management for tool execution approval.
 * Compatible with Claude Code's permission system.
 *
 * Modes (from most to least permissive):
 * - bypassPermissions: Skip all prompts (isolated containers only)
 * - auto: Auto-approve with background classifier checks
 * - acceptEdits: Auto-approve reads + file edits in working dir
 * - default: Prompt for dangerous tools
 * - dontAsk: Auto-deny dangerous tools (for CI/scripts)
 * - plan: Read-only, block all writes
 */

import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { loadPermissionsConfig, type PermissionMode, type PermissionsConfig } from "./config-loader.ts";

export type { PermissionMode };

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

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

	if (expandedPattern.includes("**")) {
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
		const regex = new RegExp(
			`^${expandedPattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]")}$`,
		);
		return regex.test(path);
	}

	return path === expandedPattern || path.includes(expandedPattern);
}

function matchesBashPattern(command: string, pattern: string): boolean {
	const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
	return regex.test(command);
}

/**
 * Parse Claude Code style permission rule: "ToolName(specifier)"
 */
function parsePermissionRule(rule: string): { tool: string; specifier?: string } {
	const match = rule.match(/^(\w+)(?:\(([^)]+)\))?$/);
	if (match) {
		return { tool: match[1], specifier: match[2] };
	}
	// Fallback: treat entire string as tool name
	return { tool: rule };
}

function matchesPermissionRule(rule: string, toolName: string, args?: Record<string, unknown>): boolean {
	const { tool, specifier } = parsePermissionRule(rule);

	// Tool name must match (or rule is wildcard)
	if (tool !== "*" && tool.toLowerCase() !== toolName.toLowerCase()) {
		return false;
	}

	// No specifier = match any args
	if (!specifier) {
		return true;
	}

	// Match specifier against relevant arg
	if (toolName === "bash" && args?.command) {
		return matchesBashPattern(String(args.command), specifier);
	}

	if ((toolName === "read" || toolName === "write" || toolName === "edit") && args?.file_path) {
		return matchesGlobPattern(String(args.file_path), specifier);
	}

	// For other tools, check if specifier matches any string arg
	for (const value of Object.values(args ?? {})) {
		if (typeof value === "string" && matchesGlobPattern(value, specifier)) {
			return true;
		}
	}

	return false;
}

export class PermissionManager {
	private mode: PermissionMode = "default";
	private config: PermissionsConfig = {};
	private sessionAllowed = new Set<string>();
	private sessionDenied = new Set<string>();
	private listeners = new Set<(mode: PermissionMode) => void>();
	private workingDir: string;

	constructor(workingDir?: string) {
		this.workingDir = workingDir ?? process.cwd();
		this.config = loadPermissionsConfig(this.workingDir);
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

	getConfig(): Readonly<PermissionsConfig> {
		return this.config;
	}

	reloadConfig(): void {
		this.config = loadPermissionsConfig(this.workingDir);
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

		// Session-level overrides
		if (this.sessionAllowed.has(toolName)) return false;
		if (this.sessionDenied.has(toolName)) return true;

		// Check Claude Code style rules (deny > ask > allow)
		if (this.config.deny?.some((rule) => matchesPermissionRule(rule, toolName, args))) {
			return true;
		}
		if (this.config.ask?.some((rule) => matchesPermissionRule(rule, toolName, args))) {
			return true;
		}
		if (this.config.allow?.some((rule) => matchesPermissionRule(rule, toolName, args))) {
			return false;
		}

		// Legacy flat lists
		if (this.config.denyList?.includes(toolName)) return true;
		if (this.config.allowList?.includes(toolName)) return false;

		// Protected paths always prompt
		if (this.isProtectedPathAccess(toolName, args)) return true;

		// Bash command patterns
		if (toolName === "bash" && args?.command) {
			const command = String(args.command);
			if (this.config.bash?.deny?.some((p) => matchesBashPattern(command, p))) return true;
			if (this.config.bash?.allow?.some((p) => matchesBashPattern(command, p))) return false;
		}

		// Mode-specific logic
		return this.shouldPromptForMode(toolName, args);
	}

	private shouldPromptForMode(toolName: string, args?: Record<string, unknown>): boolean {
		switch (this.mode) {
			case "bypassPermissions":
				return false;

			case "auto":
				// Most permissive, only prompt for MCP tools
				return toolName.startsWith("mcp__");

			case "acceptEdits":
				if (READ_ONLY_TOOLS.has(toolName)) return false;
				if (WRITE_TOOLS.has(toolName)) {
					return !this.isWithinWorkingDir(toolName, args);
				}
				return toolName.startsWith("mcp__");

			case "default":
				return WRITE_TOOLS.has(toolName) || toolName.startsWith("mcp__");

			case "dontAsk":
				// Auto-deny (handled in shouldBlock)
				return false;

			case "plan":
				// Read-only (handled in shouldBlock)
				return WRITE_TOOLS.has(toolName) || toolName.startsWith("mcp__");

			default:
				return true;
		}
	}

	private isWithinWorkingDir(toolName: string, args?: Record<string, unknown>): boolean {
		if (!args) return false;

		let targetPath: string | undefined;

		if (toolName === "write" || toolName === "edit" || toolName === "read") {
			targetPath = args.file_path as string | undefined;
		} else if (toolName === "bash") {
			const command = String(args.command ?? "");
			if (!command.includes("/") || command.startsWith("./")) {
				return true;
			}
			return false;
		}

		if (!targetPath) return false;

		const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(this.workingDir, targetPath);
		const normalizedTarget = resolve(absoluteTarget);
		const normalizedWorkingDir = resolve(this.workingDir);

		return normalizedTarget.startsWith(`${normalizedWorkingDir}/`) || normalizedTarget === normalizedWorkingDir;
	}

	private isProtectedPathAccess(toolName: string, args?: Record<string, unknown>): boolean {
		if (!args) return false;

		let targetPath: string | undefined;

		if (toolName === "write" || toolName === "edit" || toolName === "read") {
			targetPath = args.file_path as string | undefined;
		} else if (toolName === "bash") {
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
	 * Check if tool should be blocked entirely (plan/dontAsk modes).
	 */
	shouldBlock(ctx: ToolCallContext): { block: boolean; reason?: string } {
		const { toolName } = ctx;

		if (this.mode === "plan" && WRITE_TOOLS.has(toolName)) {
			return { block: true, reason: `Tool "${toolName}" blocked: plan mode is read-only` };
		}

		if (this.mode === "dontAsk" && WRITE_TOOLS.has(toolName)) {
			// In dontAsk mode, dangerous tools are auto-denied unless explicitly allowed
			if (!this.sessionAllowed.has(toolName) && !this.config.allowList?.includes(toolName)) {
				return { block: true, reason: `Tool "${toolName}" auto-denied: dontAsk mode` };
			}
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

	getModeDescription(): string {
		switch (this.mode) {
			case "bypassPermissions":
				return "Bypass all permission checks";
			case "auto":
				return "Auto-approve most tools";
			case "acceptEdits":
				return "Auto-approve edits in working dir";
			case "default":
				return "Prompt for dangerous tools";
			case "dontAsk":
				return "Auto-deny dangerous tools (CI mode)";
			case "plan":
				return "Read-only mode";
			default:
				return this.mode;
		}
	}
}
