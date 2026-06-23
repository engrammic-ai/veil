/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentVeilConfig } from "./types.ts";

const CONFIG_DIR_NAME = ".veil";

// Built-in agents shipped with Veil
// Tools omitted = inherit all from parent (including MCP/veil tools)
// Model omitted = inherit from parent (team lead decides)
const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description: "Fast codebase reconnaissance - finds files, patterns, structure",
		systemPrompt: `Locate information in the codebase. Return compressed context.

Use: grep/find for patterns, read for content. Stop when found.

Output format:
- path:line — what's there
- path:line — what's there
(no prose, no explanations unless asked)`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "reviewer",
		description: "Code review - bugs, security, performance issues",
		systemPrompt: `Review code for defects. Read the files, analyze, report.

Priority order: security > correctness > performance > style

For each finding:
  path:line [severity] — issue — fix

Severities: CRIT (ship-blocker), HIGH (fix before merge), MED (should fix), LOW (nit)

No praise. No summaries. Just findings.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "researcher",
		description: "Research topics via web search and docs",
		systemPrompt: `Research the given topic. Use WebSearch to find sources, WebFetch to read them.

Process:
1. Search for 2-3 authoritative sources (official docs, specs, reputable articles)
2. Read and extract key facts
3. Note where sources agree/disagree

Output:
## Findings
- fact (source)
- fact (source)

## Confidence
- HIGH: multiple sources agree
- MED: single authoritative source
- LOW: inferred or uncertain

## Open questions
- what remains unclear

No filler. Cite every claim.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "implementer",
		description: "Write code, run tests, make changes",
		systemPrompt: `Implement the given task.

Before coding:
1. Read existing code in the area
2. Check for patterns to follow (grep for similar code)

While coding:
- Match existing style exactly
- Minimal diff — don't refactor unrelated code
- Run tests if they exist

Report: what changed, test results, any blockers.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "planner",
		description: "Break down tasks into steps and dependencies",
		systemPrompt: `Break down the task into implementation steps.

First: read relevant code to understand current state.

Output a numbered plan:
1. [path] action — why
2. [path] action — why
   depends: 1
3. ...

Each step must name a file path or be clearly infrastructure (e.g., "run tests").
Flag risks with ⚠️.
No vague steps like "implement the feature" — be specific.`,
		source: "builtin",
		filePath: "<builtin>",
	},
];

function getVeilDir(): string {
	return path.join(os.homedir(), ".veil");
}

interface Frontmatter {
	name?: string;
	description?: string;
	tools?: string;
	model?: string;
	veil?: AgentVeilConfig;
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const yaml = match[1];
	const body = match[2];
	const frontmatter: Frontmatter = {};

	for (const line of yaml.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();

		if (key === "name") frontmatter.name = value;
		else if (key === "description") frontmatter.description = value;
		else if (key === "tools") frontmatter.tools = value;
		else if (key === "model") frontmatter.model = value;
	}

	// Parse veil block if present
	const veilMatch = yaml.match(/veil:\n((?: {2}.+\n)*)/);
	if (veilMatch) {
		frontmatter.veil = {};
		for (const line of veilMatch[1].split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("inheritWarm:")) {
				frontmatter.veil.inheritWarm = trimmed.includes("true");
			}
			if (trimmed.startsWith("enableVeilTools:")) {
				frontmatter.veil.enableVeilTools = trimmed.includes("true");
			}
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
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
			veil: frontmatter.veil,
		});
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
