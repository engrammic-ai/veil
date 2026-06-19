import type { ExtensionAPI, ToolResultEvent } from "../../core/extensions/types.ts";
import { loadConfig } from "./config.ts";
import { StatusBarLayout } from "./layout.ts";
import type { CatState, StatusBarWidget, WidgetContext } from "./types.ts";
import { CatWidget } from "./widgets/cat.ts";
import { ContextBarWidget } from "./widgets/context-bar.ts";
import { ModeWidget } from "./widgets/mode.ts";
import { ModelWidget } from "./widgets/model.ts";
import { ProjectWidget } from "./widgets/project.ts";
import { TokensWidget } from "./widgets/tokens.ts";

const WIDGET_REGISTRY: Record<string, () => StatusBarWidget> = {
	cat: () => new CatWidget(),
	project: () => new ProjectWidget(),
	"context-bar": () => new ContextBarWidget(),
	tokens: () => new TokensWidget(),
	model: () => new ModelWidget(),
	mode: () => new ModeWidget(),
};

// Map engrammic MCP tool names to cat states
const ENGRAMMIC_TOOL_STATES: Record<string, CatState> = {
	remember: "learned",
	learn: "learned",
	recall: "recalled",
	hypothesize: "remembering",
	commit: "learned",
	decide: "learned",
	reflect: "remembering",
	forget: "watching",
	link: "learned",
	tick: "watching",
	trace: "recalled",
	history: "recalled",
	patterns: "recalled",
	reason: "recalled",
	accept: "learned",
	dismiss: "watching",
	revise: "remembering",
};

// Map veil_* custom tool names to cat states
const VEIL_TOOL_STATES: Record<string, CatState> = {
	veil_recall: "recalled",
	veil_history: "recalled",
	veil_hydrate: "recalled",
	veil_remember: "learned",
	veil_promote: "recalled",
	veil_demote: "watching",
	veil_pin: "learned",
	veil_unpin: "watching",
	veil_forget: "watching",
};

function getEngrammicToolName(fullToolName: string): string | null {
	// Match mcp__engrammic__<tool> or mcp__claude_ai_engrammic__<tool>
	const match = fullToolName.match(/^mcp__(?:claude_ai_)?engrammic__(.+)$/);
	return match ? match[1] : null;
}

function getVeilToolState(toolName: string): CatState | null {
	return VEIL_TOOL_STATES[toolName] ?? null;
}

// Module-level state for session stats
let sessionStats = {
	remembered: 0,
	learned: 0,
	recalled: 0,
};
let currentLayout: StatusBarLayout | null = null;

export default function veilStatusbar(pi: ExtensionAPI) {
	// Subscribe to tool results to track engrammic MCP and veil_* calls
	pi.on("tool_result", (event: ToolResultEvent) => {
		if (!currentLayout) return;

		// Try engrammic MCP tools first
		const engrammicTool = getEngrammicToolName(event.toolName);
		let catState: CatState | null = null;
		let toolKey: string | null = null;

		if (engrammicTool) {
			catState = ENGRAMMIC_TOOL_STATES[engrammicTool] ?? null;
			toolKey = engrammicTool;
		} else {
			// Try veil_* custom tools
			catState = getVeilToolState(event.toolName);
			toolKey = event.toolName;
		}

		if (!catState || !toolKey) return;

		// Update session stats based on tool type
		if (toolKey === "remember" || toolKey === "hypothesize" || toolKey === "revise" || toolKey === "veil_remember") {
			sessionStats.remembered++;
		} else if (
			toolKey === "learn" ||
			toolKey === "commit" ||
			toolKey === "decide" ||
			toolKey === "accept" ||
			toolKey === "veil_pin"
		) {
			sessionStats.learned++;
		} else if (
			toolKey === "recall" ||
			toolKey === "trace" ||
			toolKey === "history" ||
			toolKey === "patterns" ||
			toolKey === "reason" ||
			toolKey === "veil_recall" ||
			toolKey === "veil_history" ||
			toolKey === "veil_hydrate" ||
			toolKey === "veil_promote"
		) {
			sessionStats.recalled++;
		}

		// Extract detail from tool result
		const textContent = Array.isArray(event.content) ? event.content.find((c) => c.type === "text") : null;
		const detail = textContent && "text" in textContent ? textContent.text?.slice(0, 30) : undefined;

		// Emit memory event to update cat widget
		currentLayout.emit({ type: "memory", state: catState, detail });
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Reset session stats on new session
		sessionStats = { remembered: 0, learned: 0, recalled: 0 };

		const config = loadConfig(ctx.cwd);

		ctx.ui.setFooter((_tui, theme, footerData) => {
			const layout = new StatusBarLayout();
			currentLayout = layout;

			const widgetCtx: WidgetContext = {
				sessionManager: ctx.sessionManager,
				footerData,
				theme,
				modelName: ctx.model?.name,
				permissionMode: footerData.getPermissionMode(),
			};

			for (const id of config.left) {
				const factory = WIDGET_REGISTRY[id];
				if (factory) {
					const widget = factory();
					widget.init(config.widgetConfigs[id] ?? {}, widgetCtx);
					layout.addWidget(widget, "left");
				}
			}

			for (const id of config.right) {
				const factory = WIDGET_REGISTRY[id];
				if (factory) {
					const widget = factory();
					widget.init(config.widgetConfigs[id] ?? {}, widgetCtx);
					layout.addWidget(widget, "right");
				}
			}

			// Subscribe to permission mode changes and forward as WidgetEvents
			const unsubscribeMode = footerData.onPermissionModeChange((mode) => {
				layout.emit({ type: "mode", mode });
			});

			return {
				render: (width: number) => layout.render(width),
				invalidate: () => layout.invalidate(),
				dispose: () => {
					unsubscribeMode();
					currentLayout = null;
					layout.dispose();
				},
			};
		});
	});

	// Export session stats for session end rendering
	pi.on("session_shutdown", () => {
		// Stats are available via getSessionStats() if needed
		currentLayout = null;
	});
}

// Export for external access (e.g., session end rendering)
export function getSessionStats() {
	return {
		remembered: sessionStats.remembered,
		learned: sessionStats.learned,
		recalled: sessionStats.recalled,
		stabilityAvg: 0, // TODO: wire from VeilHarness if available
		conflicts: 0,
		evicted: 0,
	};
}
