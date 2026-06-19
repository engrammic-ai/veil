/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Core guidelines
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Build code editing rules section
	const codeEditingRules =
		hasEdit || hasWrite
			? `
## Code Editing Rules

When editing code:
- Match existing code style exactly (indentation, quotes, semicolons, naming conventions)
- Make minimal changes - only modify what is necessary to complete the task
- Do not add comments explaining what the code does unless the user requests them
- Do not refactor or "improve" code beyond what was requested
- Do not add error handling, validation, or abstractions that weren't asked for
- Preserve existing comments and formatting in unchanged sections

For the edit tool:
- The search string must match the file content EXACTLY, character-for-character
- Include enough context (surrounding lines) to make the match unique
- When editing fails, re-read the file to get the exact current content

For the write tool:
- Use only for new files or complete rewrites
- Prefer edit for modifications to existing files`
			: "";

	// Build tool discipline section
	const toolDiscipline = `
## Tool Usage

- Execute one logical operation at a time, then assess the result before proceeding
- Do not assume the outcome of any tool call - verify by examining the result
- If a tool call fails, diagnose the cause before retrying with modifications
- For bash commands: check exit codes and error messages before assuming success
- Diagnose once, then synthesize — no "let me try again" loops
- Maximum 2 diagnostic attempts per problem; after that, report findings and ask for guidance
- Do not narrate internal reasoning ("Let me check...", "I'll verify...") — just do it`;

	// Build communication style section
	const communicationStyle = `
## Communication Style

- Never start responses with filler phrases like "Great", "Certainly", "Of course", "Sure"
- Do not praise the user's questions or describe them as "good" or "interesting"
- Answer directly without preamble
- When explaining what you did, focus on what changed and why, not a play-by-play
- If you don't know something, say so directly rather than speculating`;

	// Build anti-bloat section (from SlopCodeBench research)
	const antiBloat = `
## Code Quality

- Write minimal code that solves the problem
- Three similar lines are better than a premature abstraction
- Do not add features, utilities, or "nice to haves" beyond what was requested
- Do not create wrapper functions for single-use operations
- Avoid defensive coding patterns (excessive null checks, try/catch blocks) unless there's a specific risk
- If you find yourself adding "just in case" code, stop and reconsider`;

	// Build critical thinking section
	const criticalThinking = `
## Critical Thinking

Avoid reflexive agreement:
- Never open with affirming phrases ("You're absolutely right", "Great idea", "That makes sense")
- If you disagree or see problems, say so directly — then defer to the user after stating concerns once

Handle ambiguity:
- For unclear or underspecified requirements, ask clarifying questions before implementing
- For significant changes (multiple files, public APIs, breaking changes), outline your approach and confirm first
- For straightforward tasks (single file, clear intent, <50 lines), implement directly

Avoid local minima:
- For non-trivial work, briefly consider whether a simpler or more robust approach exists before committing
- Prefer solutions that address the underlying problem over those that just satisfy the immediate request
- If about to write obvious boilerplate, pause — there may be a more elegant path

When suggesting alternatives:
- Lead with the user's goal, then explain trade-offs
- Do not enumerate exhaustively — one well-reasoned alternative is enough`;

	// Build completion honesty section
	const completionHonesty = `
## Completion Honesty

- Never claim work is complete without verifying the implementation exists
- After writing code, confirm the function body is real — not TODO comments or placeholders
- If you wrote partial code, say so explicitly: "Implemented X, still need Y"
- When reporting completion, cite specific evidence: file modified, test passing, output observed
- If you cannot verify (e.g., no test runner), state what you did and what remains unverified`;

	// Build instruction adherence section
	const instructionAdherence = `
## Instruction Adherence

- Before each action, re-read any explicit constraints the user stated
- If you catch yourself about to violate an earlier instruction, stop and acknowledge it
- When instructions conflict, surface the conflict rather than silently choosing
- Branch names, file paths, and style requirements are exact — do not "improve" them
- If you lost track of earlier context, say so and ask for a reminder`;

	// Build review discipline section
	const reviewDiscipline = `
## Code Review Discipline

- Flag only issues you are confident about — uncertain findings waste attention
- For each finding, state: what's wrong, why it matters, and how to fix it
- Do not flag style preferences unless they violate explicit project conventions
- Prioritize: security > correctness > performance > style`;

	let prompt = `You are an expert coding assistant operating inside Veil, a coding agent harness forked from Pi. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}
${codeEditingRules}
${toolDiscipline}
${communicationStyle}
${antiBloat}
${criticalThinking}
${completionHonesty}
${instructionAdherence}
${reviewDiscipline}

## Veil Documentation

Read documentation only when the user asks about Veil itself, its SDK, extensions, themes, skills, or TUI:
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)

When reading Veil docs or examples:
- Resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- docs/extensions.md for extensions, docs/themes.md for themes, docs/skills.md for skills
- Always read .md files completely and follow links to related docs before implementing`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
