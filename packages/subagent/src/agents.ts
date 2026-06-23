/**
 * Agent discovery and configuration
 * Aligned with pi-subagents format for minimal fork maintenance
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentConfig,
	AgentDiscoveryResult,
	AgentScope,
	IsolationMode,
	MemoryScope,
	ThinkingLevel,
} from "./types.ts";
import { BUILTIN_TOOL_NAMES } from "./types.ts";

const CONFIG_DIR_NAME = ".veil";
// Read-only tools for Explore/Plan agents (no writes, no state changes)
const READ_ONLY_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	// Read-only veil tools
	"veil_recall",
	"veil_hydrate",
	"veil_history",
	"veil_conflicts",
];

// Built-in agents - aligned with pi-subagents DEFAULT_AGENTS format
const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "general-purpose",
		displayName: "Agent",
		description:
			"General-purpose agent for complex questions, code search, and multi-step tasks. Use when unsure which specialist to pick.",
		extensions: true,
		skills: true,
		systemPrompt: "",
		promptMode: "append",
		source: "builtin",
		filePath: "<builtin>",
		isDefault: true,
	},
	{
		name: "Explore",
		displayName: "Explore",
		description:
			'Fast read-only search agent. Use for: file patterns ("src/**/*.tsx"), symbol grep, "where is X defined". NOT for review or analysis.',
		builtinToolNames: READ_ONLY_TOOLS,
		extensions: true,
		skills: true,
		systemPrompt: `# READ-ONLY MODE
You search and analyze code. You cannot edit files.

PROHIBITED: create/modify/delete files, redirects (>, >>), heredocs, state-changing commands.

USE: find tool (not bash find), grep tool (not bash grep), read tool (not cat).
Parallelize independent lookups. Use absolute paths. No emojis.`,
		promptMode: "replace",
		source: "builtin",
		filePath: "<builtin>",
		isDefault: true,
	},
	{
		name: "Plan",
		displayName: "Plan",
		description: "Software architect for implementation plans. Returns step-by-step plans with critical files.",
		builtinToolNames: READ_ONLY_TOOLS,
		extensions: true,
		skills: true,
		systemPrompt: `# READ-ONLY PLANNING MODE
You design implementation plans. You cannot edit files.

1. Understand requirements
2. Explore codebase (read files, find patterns)
3. Design solution
4. Output step-by-step plan with file paths

End with:
### Critical Files
- /path/to/file.ts - reason`,
		promptMode: "replace",
		source: "builtin",
		filePath: "<builtin>",
		isDefault: true,
	},
];

function getVeilDir(): string {
	return path.join(os.homedir(), ".veil");
}

// --- Field parsers (aligned with pi-subagents/custom-agents.ts) ---

function str(val: unknown): string | undefined {
	return typeof val === "string" && val.trim() ? val.trim() : undefined;
}

function nonNegativeInt(val: unknown): number | undefined {
	if (typeof val === "string") {
		const n = parseInt(val, 10);
		return !Number.isNaN(n) && n >= 0 ? n : undefined;
	}
	return typeof val === "number" && val >= 0 ? val : undefined;
}

function parseCsvField(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s === "none") return undefined;
	const items = s
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function csvList(val: unknown, defaults: string[]): string[] {
	if (val === undefined || val === null) return defaults;
	return parseCsvField(val) ?? [];
}

function parseToolsField(val: unknown): { builtinToolNames: string[]; extSelectors: string[] | undefined } {
	const entries = csvList(val, [...BUILTIN_TOOL_NAMES]);
	const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
	const hasWildcard = entries.some(isWildcard);
	const plain = entries.filter((e) => !isWildcard(e) && !e.startsWith("ext:"));
	const extEntries = entries.filter((e) => e.startsWith("ext:"));
	return {
		builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
		extSelectors: extEntries.length > 0 ? extEntries : undefined,
	};
}

function inheritField(val: unknown): true | string[] | false {
	if (val === undefined || val === null || val === true || val === "true") return true;
	if (val === false || val === "false" || val === "none") return false;
	const items = csvList(val, []);
	return items.length > 0 ? items : false;
}

function boolField(val: unknown): boolean | undefined {
	if (val === true || val === "true") return true;
	if (val === false || val === "false") return false;
	return undefined;
}

interface RawFrontmatter {
	name?: string;
	display_name?: string;
	description?: string;
	tools?: string;
	disallowed_tools?: string;
	extensions?: unknown;
	inherit_extensions?: unknown;
	exclude_extensions?: string;
	skills?: unknown;
	inherit_skills?: unknown;
	model?: string;
	thinking?: string;
	max_turns?: unknown;
	prompt_mode?: string;
	inherit_context?: unknown;
	run_in_background?: unknown;
	isolated?: unknown;
	memory?: string;
	isolation?: string;
	enabled?: unknown;
}

function parseFrontmatter(content: string): { frontmatter: RawFrontmatter; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const yaml = match[1];
	const body = match[2];
	const frontmatter: RawFrontmatter = {};

	for (const line of yaml.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		// Skip indented lines (nested YAML)
		if (line.startsWith(" ") || line.startsWith("\t")) continue;

		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();

		switch (key) {
			case "name":
				frontmatter.name = value;
				break;
			case "display_name":
				frontmatter.display_name = value;
				break;
			case "description":
				frontmatter.description = value;
				break;
			case "tools":
				frontmatter.tools = value;
				break;
			case "disallowed_tools":
				frontmatter.disallowed_tools = value;
				break;
			case "extensions":
			case "inherit_extensions":
				frontmatter.extensions = value || true;
				break;
			case "exclude_extensions":
				frontmatter.exclude_extensions = value;
				break;
			case "skills":
			case "inherit_skills":
				frontmatter.skills = value || true;
				break;
			case "model":
				frontmatter.model = value;
				break;
			case "thinking":
				frontmatter.thinking = value;
				break;
			case "max_turns":
				frontmatter.max_turns = value;
				break;
			case "prompt_mode":
				frontmatter.prompt_mode = value;
				break;
			case "inherit_context":
				frontmatter.inherit_context = value;
				break;
			case "run_in_background":
				frontmatter.run_in_background = value;
				break;
			case "isolated":
				frontmatter.isolated = value;
				break;
			case "memory":
				frontmatter.memory = value;
				break;
			case "isolation":
				frontmatter.isolation = value;
				break;
			case "enabled":
				frontmatter.enabled = value;
				break;
		}
	}

	return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const name = path.basename(entry.name, ".md");

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter: fm, body } = parseFrontmatter(content);

		// Use filename as name if not specified
		const agentName = fm.name || name;
		const description = fm.description || agentName;

		const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

		const agent: AgentConfig = {
			name: agentName,
			displayName: str(fm.display_name),
			description,
			builtinToolNames,
			extSelectors,
			disallowedTools: parseCsvField(fm.disallowed_tools),
			extensions: inheritField(fm.extensions),
			excludeExtensions: parseCsvField(fm.exclude_extensions),
			skills: inheritField(fm.skills),
			model: str(fm.model),
			thinking: str(fm.thinking) as ThinkingLevel | undefined,
			maxTurns: nonNegativeInt(fm.max_turns),
			systemPrompt: body.trim(),
			promptMode: fm.prompt_mode === "append" ? "append" : "replace",
			inheritContext: boolField(fm.inherit_context),
			runInBackground: boolField(fm.run_in_background),
			isolated: boolField(fm.isolated),
			memory: (["user", "project", "local"].includes(fm.memory ?? "") ? fm.memory : undefined) as
				| MemoryScope
				| undefined,
			isolation: fm.isolation === "worktree" ? ("worktree" as IsolationMode) : undefined,
			enabled: fm.enabled !== "false" && fm.enabled !== false,
			source,
			filePath,
		};

		agents.push(agent);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Get built-in agents shipped with Veil
 */
export function getBuiltinAgents(): AgentConfig[] {
	return [...BUILTIN_AGENTS];
}

/**
 * Discover agents from all sources.
 * Precedence (highest wins): project > user > builtin
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getVeilDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Build map with precedence: builtin < user < project
	const agentMap = new Map<string, AgentConfig>();

	// Start with built-ins (lowest precedence)
	for (const agent of BUILTIN_AGENTS) {
		agentMap.set(agent.name, agent);
	}

	// User agents override built-ins
	if (scope !== "project") {
		for (const agent of userAgents) {
			agentMap.set(agent.name, agent);
		}
	}

	// Project agents override user and built-ins
	if (scope !== "user") {
		for (const agent of projectAgents) {
			agentMap.set(agent.name, agent);
		}
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
