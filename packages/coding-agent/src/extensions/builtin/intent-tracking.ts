/**
 * Intent Tracking Extension
 *
 * Detects user intent from messages and stores them via SessionIntentManager.
 * Intents are pinned against eviction so the agent stays on track.
 */

import { SessionIntentManager } from "@engrammic/veil-context";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

const INTENT_PATTERNS = [
	/^let'?s\s+(?:work\s+on|build|create|implement|add|fix|refactor)\s+(.+)/i,
	/^i\s+want\s+(?:to|you\s+to)\s+(.+)/i,
	/^(?:can\s+you|please)\s+(.+)/i,
	/^we\s+need\s+(?:to\s+)?(.+)/i,
	/^(?:help\s+me|i\s+need\s+help)\s+(?:with\s+)?(.+)/i,
	/^(?:the\s+goal\s+is|our\s+goal\s+is)\s+(.+)/i,
];

function detectIntent(text: string): { content: string; confidence: "explicit" | "inferred" } | null {
	const trimmed = text.trim();

	for (const pattern of INTENT_PATTERNS) {
		const match = trimmed.match(pattern);
		if (match) {
			return {
				content: match[1].trim(),
				confidence: "inferred",
			};
		}
	}

	return null;
}

export default function intentTrackingExtension(pi: ExtensionAPI): void {
	let intentManager: SessionIntentManager | null = null;

	async function getManager(ctx: ExtensionContext): Promise<SessionIntentManager> {
		if (!intentManager) {
			intentManager = await SessionIntentManager.load({
				sessionId: ctx.sessionManager.getSessionId(),
				projectRoot: ctx.cwd,
			});
		}
		return intentManager;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!intentManager) {
			ctx.ui.setStatus("intent", undefined);
			return;
		}

		const current = intentManager.getCurrent() ?? intentManager.getPrimary();
		if (current) {
			const truncated = current.content.length > 40 ? `${current.content.slice(0, 37)}...` : current.content;
			ctx.ui.setStatus("intent", ctx.ui.theme.fg("dim", `[${truncated}]`));
		} else {
			ctx.ui.setStatus("intent", undefined);
		}
	}

	pi.registerCommand("intent", {
		description: "Show or set current session intent",
		handler: async (args, ctx) => {
			const manager = await getManager(ctx);

			if (args.trim()) {
				manager.createPrimary(args.trim(), { confidence: "explicit", source: "user" });
				ctx.ui.notify(`Intent set: ${args.trim()}`);
				updateStatus(ctx);
				return;
			}

			const all = manager.getAll();
			if (all.length === 0) {
				ctx.ui.notify("No intent tracked yet. Start with 'let's work on...' or /intent <goal>");
				return;
			}

			const primary = manager.getPrimary();
			const current = manager.getCurrent();
			const subs = primary ? manager.getSubIntents(primary.id) : [];

			let display = `Primary: ${primary?.content ?? "(none)"}\n`;
			if (current && current.id !== primary?.id) {
				display += `Current: ${current.content}\n`;
			}
			if (subs.length > 0) {
				display += `Sub-intents:\n`;
				for (const sub of subs) {
					const status = sub.status === "completed" ? "[done]" : sub.current ? "[current]" : "";
					display += `  - ${sub.content} ${status}\n`;
				}
			}
			ctx.ui.notify(display.trim());
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		intentManager = await SessionIntentManager.load({
			sessionId: ctx.sessionManager.getSessionId(),
			projectRoot: ctx.cwd,
		});
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.prompt) return;

		const manager = await getManager(ctx);
		const existing = manager.getPrimary();

		if (!existing) {
			const detected = detectIntent(event.prompt);
			if (detected) {
				manager.createPrimary(detected.content, {
					confidence: detected.confidence,
					source: "user",
				});
				updateStatus(ctx);
			}
		}
	});
}
