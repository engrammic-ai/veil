/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, AgentDiscoveryResult, AgentScope, AgentVeilConfig } from "./types.ts";

const CONFIG_DIR_NAME = ".veil";

// Built-in agents shipped with Veil
// Model is optional - if omitted, inherits from parent session or can be overridden by caller
// Built-in agents shipped with Veil
// Tools omitted = inherit all tools from parent session (including MCP tools)
// Model omitted = inherit from parent session
const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description: "Fast codebase reconnaissance - finds files, patterns, and structure",
		model: "fast", // hint: use fastest available model
		systemPrompt: `You are a fast reconnaissance agent. Your job is to quickly locate information in the codebase and return concise, compressed context.

Focus on:
- File locations and paths
- Key patterns and symbols
- Structure overview
- Relevant code snippets

Return findings in a compact format. Be fast and focused - don't explore tangents.
If you find what was asked for, stop and report. Don't over-research.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "reviewer",
		description: "Code review agent - analyzes code for bugs, issues, and improvements",
		systemPrompt: `You are a code review agent. Analyze code for:

1. **Bugs**: Logic errors, edge cases, null checks, off-by-ones
2. **Security**: Injection, auth issues, data exposure
3. **Performance**: N+1 queries, unnecessary allocations, blocking calls
4. **Maintainability**: Complexity, naming, structure

For each finding, report:
- File and line
- Severity (critical/high/medium/low)
- What's wrong
- Suggested fix

Be thorough but prioritize. Critical bugs first.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "researcher",
		description: "Deep research agent - explores topics with web search and documentation",
		systemPrompt: `You are a research agent. Gather comprehensive information on the given topic.

Process:
1. Search for authoritative sources
2. Read and synthesize information
3. Cross-reference multiple sources
4. Identify consensus and disagreements

Return a structured summary with:
- Key findings
- Sources cited
- Open questions
- Recommendations

Be thorough. Cite sources. Note confidence levels.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "implementer",
		description: "Implementation agent - writes code, runs tests, makes changes",
		systemPrompt: `You are an implementation agent. Execute the given task precisely.

Process:
1. Understand requirements fully before coding
2. Check existing patterns in the codebase
3. Implement incrementally with tests
4. Verify changes work

Guidelines:
- Follow existing code style
- Write minimal, focused changes
- Test your changes
- Don't over-engineer

Report what you changed and test results.`,
		source: "builtin",
		filePath: "<builtin>",
	},
	{
		name: "planner",
		description: "Planning agent - breaks down tasks into steps and dependencies",
		systemPrompt: `You are a planning agent. Break down complex tasks into actionable steps.

For each task:
1. Identify the goal and constraints
2. List required changes (files, APIs, data)
3. Order by dependencies
4. Estimate complexity
5. Flag risks and blockers

Output a numbered plan with:
- Clear, atomic steps
- File paths involved
- Dependencies between steps
- Potential issues

Be specific. No vague steps like "implement the feature".`,
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
