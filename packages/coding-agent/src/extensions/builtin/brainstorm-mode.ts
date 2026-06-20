/**
 * Brainstorm Mode Extension
 *
 * Guided brainstorming for turning ideas into designs before implementation.
 * Inspired by superpowers brainstorming skill.
 *
 * Features:
 * - /brainstorm [topic] command to start
 * - Auto-triggers when user says "brainstorm" in their prompt
 * - Read-only exploration mode
 * - Guided workflow: explore -> questions -> approaches -> design -> approval
 * - Transitions to plan mode or execution after approval
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

// Tools available during brainstorming (read-only + questionnaire)
const BRAINSTORM_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_TOOLS = ["read", "bash", "edit", "write"];

// Phases of brainstorming
type BrainstormPhase = "explore" | "questions" | "approaches" | "design" | "approval" | "complete";

const PHASE_LABELS: Record<BrainstormPhase, string> = {
	explore: "exploring",
	questions: "clarifying",
	approaches: "proposing",
	design: "designing",
	approval: "awaiting approval",
	complete: "complete",
};

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function detectBrainstormKeyword(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("brainstorm") ||
		lower.includes("let's design") ||
		lower.includes("help me think through") ||
		lower.includes("let's think about")
	);
}

export default function brainstormModeExtension(pi: ExtensionAPI): void {
	let brainstormEnabled = false;
	let currentPhase: BrainstormPhase = "explore";
	let topic = "";

	function updateStatus(ctx: ExtensionContext): void {
		if (brainstormEnabled) {
			const phaseLabel = PHASE_LABELS[currentPhase];
			ctx.ui.setStatus("brainstorm-mode", ctx.ui.theme.fg("accent", `[brainstorm: ${phaseLabel}]`));
		} else {
			ctx.ui.setStatus("brainstorm-mode", undefined);
		}
	}

	function startBrainstorm(ctx: ExtensionContext, newTopic: string): void {
		brainstormEnabled = true;
		currentPhase = "explore";
		topic = newTopic;
		pi.setActiveTools(BRAINSTORM_TOOLS);
		ctx.ui.notify(`Brainstorm mode: ${topic || "open exploration"}`);
		updateStatus(ctx);
		persistState();
	}

	function endBrainstorm(ctx: ExtensionContext): void {
		brainstormEnabled = false;
		currentPhase = "explore";
		topic = "";
		pi.setActiveTools(NORMAL_TOOLS);
		ctx.ui.notify("Brainstorm complete. Full access restored.");
		updateStatus(ctx);
		persistState();
	}

	function persistState(): void {
		pi.appendEntry("brainstorm-mode", {
			enabled: brainstormEnabled,
			phase: currentPhase,
			topic,
		});
	}

	// Register /brainstorm command
	pi.registerCommand("brainstorm", {
		description: "Start brainstorming mode for guided design exploration",
		handler: async (args, ctx) => {
			if (brainstormEnabled) {
				const choice = await ctx.ui.select("Already brainstorming. What do you want to do?", [
					"Continue current brainstorm",
					"Start fresh brainstorm",
					"Exit brainstorm mode",
				]);
				if (choice === "Start fresh brainstorm") {
					startBrainstorm(ctx, args);
				} else if (choice === "Exit brainstorm mode") {
					endBrainstorm(ctx);
				}
			} else {
				startBrainstorm(ctx, args);
				// Trigger the brainstorm with initial message
				const startMessage = topic
					? `Let's brainstorm: ${topic}`
					: "Let's brainstorm. What would you like to explore?";
				pi.sendMessage(
					{ customType: "brainstorm-start", content: startMessage, display: true },
					{ triggerTurn: true },
				);
			}
		},
	});

	// Block destructive bash commands in brainstorm mode (same as plan mode)
	pi.on("tool_call", async (event) => {
		if (!brainstormEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		const safePatterns = [
			/^(ls|cat|head|tail|less|more|grep|find|wc|file|stat|which|whereis|type|pwd|echo|date|whoami|hostname|uname)\b/,
			/^git\s+(status|log|diff|show|branch|remote|tag|describe|rev-parse|ls-files|ls-tree)\b/,
			/^(npm|yarn|pnpm)\s+(list|ls|info|view|show|why|audit)\b/,
		];

		const isSafe = safePatterns.some((pattern) => pattern.test(command.trim()));
		if (!isSafe) {
			return {
				block: true,
				reason: `Brainstorm mode: command blocked. Use /brainstorm to exit first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale brainstorm context when not in brainstorm mode
	pi.on("context", async (event) => {
		if (brainstormEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "brainstorm-context") return false;
				return true;
			}),
		};
	});

	// Detect "brainstorm" keyword in user messages
	pi.on("before_agent_start", async (event, ctx) => {
		// Check if user prompt contains brainstorm trigger
		if (!brainstormEnabled && event.prompt) {
			const text = event.prompt;
			if (detectBrainstormKeyword(text)) {
				// Extract topic from message
				const topicMatch = text.match(/brainstorm(?:ing)?\s+(?:about\s+)?(.+)/i);
				const detectedTopic = topicMatch ? topicMatch[1].trim() : text;
				startBrainstorm(ctx, detectedTopic);
			}
		}

		// Inject brainstorm context
		if (brainstormEnabled) {
			return {
				message: {
					customType: "brainstorm-context",
					content: `[BRAINSTORM MODE - ${topic || "Open Exploration"}]

You are in brainstorm mode - a guided design exploration before implementation.

**Current phase:** ${currentPhase}

**Restrictions:**
- Read-only tools: read, bash (safe commands), grep, find, ls, questionnaire
- NO file modifications until design is approved

**Brainstorm workflow:**
1. **Explore** - Check project context: files, docs, recent commits
2. **Clarify** - Ask questions ONE AT A TIME to understand purpose, constraints, success criteria
3. **Propose** - Present 2-3 approaches with trade-offs and your recommendation
4. **Design** - Present the design incrementally, get approval after each section
5. **Approve** - User approves, then transition to implementation

**Guidelines:**
- One question per message
- Prefer multiple choice when possible
- YAGNI ruthlessly - remove unnecessary features
- Scale detail to complexity (brief for simple, detailed for complex)
- Follow existing patterns in the codebase

**Phase markers:** Include these in your response to track progress:
- [PHASE:questions] - Moving to clarifying questions
- [PHASE:approaches] - Presenting approaches
- [PHASE:design] - Presenting design
- [PHASE:approval] - Design ready for approval

Do NOT implement anything. Just explore, clarify, and design.`,
					display: false,
				},
			};
		}
	});

	// Track phase transitions and handle completion
	pi.on("agent_end", async (event, ctx) => {
		if (!brainstormEnabled || !ctx.hasUI) return;

		// Check for phase markers in the last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const text = getTextContent(lastAssistant);

			// Update phase based on markers
			if (text.includes("[PHASE:questions]")) currentPhase = "questions";
			else if (text.includes("[PHASE:approaches]")) currentPhase = "approaches";
			else if (text.includes("[PHASE:design]")) currentPhase = "design";
			else if (text.includes("[PHASE:approval]")) currentPhase = "approval";

			updateStatus(ctx);
		}

		// If in approval phase, prompt for next action
		if (currentPhase === "approval") {
			const choice = await ctx.ui.select("Design presented. What next?", [
				"Approve and create implementation plan",
				"Approve and start implementation",
				"Refine the design",
				"Start over",
			]);

			if (choice === "Approve and create implementation plan") {
				endBrainstorm(ctx);
				// Trigger plan mode
				pi.sendMessage(
					{
						customType: "brainstorm-to-plan",
						content: "Design approved. Create a detailed implementation plan for this design.",
						display: true,
					},
					{ triggerTurn: true },
				);
			} else if (choice === "Approve and start implementation") {
				endBrainstorm(ctx);
				pi.sendMessage(
					{
						customType: "brainstorm-execute",
						content: "Design approved. Implement the design.",
						display: true,
					},
					{ triggerTurn: true },
				);
			} else if (choice === "Refine the design") {
				currentPhase = "design";
				updateStatus(ctx);
				const refinement = await ctx.ui.editor("What would you like to change?", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim());
				}
			} else if (choice === "Start over") {
				currentPhase = "explore";
				updateStatus(ctx);
				pi.sendMessage(
					{ customType: "brainstorm-restart", content: "Let's start the brainstorm fresh.", display: true },
					{ triggerTurn: true },
				);
			}
		}

		persistState();
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();

		const brainstormEntry = entries
			.filter(
				(e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "brainstorm-mode",
			)
			.pop() as { data?: { enabled: boolean; phase?: BrainstormPhase; topic?: string } } | undefined;

		if (brainstormEntry?.data) {
			brainstormEnabled = brainstormEntry.data.enabled ?? false;
			currentPhase = brainstormEntry.data.phase ?? "explore";
			topic = brainstormEntry.data.topic ?? "";
		}

		if (brainstormEnabled) {
			pi.setActiveTools(BRAINSTORM_TOOLS);
		}
		updateStatus(ctx);
	});
}
