/**
 * Unified config loader for veil (Claude Code compatible structure).
 *
 * Paths (precedence high to low):
 * - .veil/settings.local.json (project local, gitignored)
 * - .veil/settings.json (project, committed)
 * - ~/.veil/settings.local.json (user local)
 * - ~/.veil/settings.json (user global)
 *
 * Merge: deep merge, higher precedence wins.
 * Exception: permissions.allow/deny MERGE across all scopes.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Re-export for convenience
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

export interface VeilSettings {
	// Model
	model?: string;
	fallbackModel?: string[];
	effortLevel?: "low" | "medium" | "high" | "xhigh";

	// Permissions
	permissions?: PermissionsConfig;

	// UI
	theme?: string;
	editorMode?: "normal" | "vim";
	autoScrollEnabled?: boolean;
	showTurnDuration?: boolean;

	// Memory & Context
	autoCompactEnabled?: boolean;
	autoMemoryEnabled?: boolean;

	// Git
	includeGitInstructions?: boolean;
	attribution?: {
		commit?: string;
		pr?: string;
	};

	// Statusbar
	statusbar?: StatusbarConfig;

	// Keybindings
	keybindings?: Record<string, string>;

	// Environment
	env?: Record<string, string>;
}

export interface PermissionsConfig {
	// Default permission mode
	defaultMode?: PermissionMode;

	// Tool permission rules (Claude Code syntax: "ToolName(specifier)")
	allow?: string[];
	ask?: string[];
	deny?: string[];

	// Legacy flat lists (for simpler config)
	allowList?: string[];
	denyList?: string[];

	// Protected paths that always prompt
	protectedPaths?: string[];

	// Bash-specific patterns
	bash?: {
		allow?: string[];
		deny?: string[];
	};
}

export interface StatusbarConfig {
	preset?: string;
	left?: string[];
	right?: string[];
	hide?: string[];
	widgets?: Record<string, Record<string, unknown>>;
}

const MODE_STRICTNESS: Record<string, number> = {
	bypassPermissions: 1,
	auto: 2,
	acceptEdits: 3,
	default: 4,
	dontAsk: 5,
	plan: 6,
};

function parseJsonc(content: string): unknown {
	const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	return JSON.parse(stripped);
}

function loadJsonFile(path: string): unknown | null {
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf8");
		return parseJsonc(content);
	} catch {
		return null;
	}
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overlay)) {
		const baseVal = base[key];
		const overlayVal = overlay[key];

		if (overlayVal === undefined) continue;

		if (
			typeof baseVal === "object" &&
			baseVal !== null &&
			!Array.isArray(baseVal) &&
			typeof overlayVal === "object" &&
			overlayVal !== null &&
			!Array.isArray(overlayVal)
		) {
			result[key] = deepMerge(baseVal as Record<string, unknown>, overlayVal as Record<string, unknown>);
		} else {
			result[key] = overlayVal;
		}
	}

	return result;
}

function mergeArraysUnique(...arrays: (string[] | undefined)[]): string[] {
	const set = new Set<string>();
	for (const arr of arrays) {
		if (arr) {
			for (const item of arr) {
				set.add(item);
			}
		}
	}
	return [...set];
}

/**
 * Merge permissions with security constraints.
 * - allow/deny/ask arrays MERGE (union across all scopes)
 * - defaultMode: lower scope can only set stricter mode
 */
function mergePermissions(...configs: (PermissionsConfig | undefined)[]): PermissionsConfig {
	const result: PermissionsConfig = {};

	// Find strictest mode
	let strictestMode: PermissionMode = "default";
	let strictestLevel = MODE_STRICTNESS.default;

	for (const config of configs) {
		if (!config) continue;

		if (config.defaultMode) {
			const level = MODE_STRICTNESS[config.defaultMode] ?? MODE_STRICTNESS.default;
			if (level > strictestLevel) {
				strictestLevel = level;
				strictestMode = config.defaultMode;
			}
		}
	}
	result.defaultMode = strictestMode;

	// Merge arrays (union)
	result.allow = mergeArraysUnique(...configs.map((c) => c?.allow));
	result.ask = mergeArraysUnique(...configs.map((c) => c?.ask));
	result.deny = mergeArraysUnique(...configs.map((c) => c?.deny));
	result.allowList = mergeArraysUnique(...configs.map((c) => c?.allowList));
	result.denyList = mergeArraysUnique(...configs.map((c) => c?.denyList));
	result.protectedPaths = mergeArraysUnique(...configs.map((c) => c?.protectedPaths));

	// Merge bash patterns
	const bashAllows = configs.map((c) => c?.bash?.allow).filter(Boolean) as string[][];
	const bashDenys = configs.map((c) => c?.bash?.deny).filter(Boolean) as string[][];
	if (bashAllows.length || bashDenys.length) {
		result.bash = {
			allow: mergeArraysUnique(...bashAllows),
			deny: mergeArraysUnique(...bashDenys),
		};
	}

	return result;
}

export function loadSettings(cwd: string): VeilSettings {
	// Load in precedence order (lowest to highest)
	const layers: VeilSettings[] = [];

	// 1. User global
	const userGlobal = loadJsonFile(join(homedir(), ".veil", "settings.json"));
	if (userGlobal) layers.push(userGlobal as VeilSettings);

	// 2. User local
	const userLocal = loadJsonFile(join(homedir(), ".veil", "settings.local.json"));
	if (userLocal) layers.push(userLocal as VeilSettings);

	// 3. Project shared
	const projectShared = loadJsonFile(join(cwd, ".veil", "settings.json"));
	if (projectShared) layers.push(projectShared as VeilSettings);

	// 4. Project local
	const projectLocal = loadJsonFile(join(cwd, ".veil", "settings.local.json"));
	if (projectLocal) layers.push(projectLocal as VeilSettings);

	if (layers.length === 0) {
		return {};
	}

	// Deep merge all non-permission settings
	let merged: VeilSettings = {};
	for (const layer of layers) {
		const { permissions: _permissions, ...rest } = layer;
		merged = deepMerge(merged as Record<string, unknown>, rest as Record<string, unknown>) as VeilSettings;
	}

	// Special merge for permissions
	merged.permissions = mergePermissions(...layers.map((l) => l.permissions));

	return merged;
}

// Convenience loaders for specific sections
export function loadPermissionsConfig(cwd: string): PermissionsConfig {
	return loadSettings(cwd).permissions ?? {};
}

export function loadStatusbarConfig(cwd: string): StatusbarConfig {
	return loadSettings(cwd).statusbar ?? {};
}

export function loadKeybindingsConfig(cwd: string): Record<string, string> {
	return loadSettings(cwd).keybindings ?? {};
}

// Legacy export for backwards compat
export { loadSettings as loadConfig };
export type { VeilSettings as VeilConfig };
