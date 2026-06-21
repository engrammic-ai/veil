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

// Map veil_* custom tool names to cat states (only tracking local veil tools)
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

let currentLayout: StatusBarLayout | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 120000; // 2 minutes to go to sleep

function resetIdleTimer() {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		if (currentLayout) {
			currentLayout.emit({ type: "memory", state: "sleeping" as CatState, detail: "" });
		}
	}, IDLE_TIMEOUT_MS);
}

function wakeUp() {
	if (currentLayout) {
		currentLayout.emit({ type: "memory", state: "watching" as CatState, detail: "" });
	}
	resetIdleTimer();
}

const VEIL_HARNESS_KEY = Symbol.for("veil:harness");

export default function veilStatusbar(pi: ExtensionAPI) {
	// Subscribe to tool results to track veil_* custom tool calls only
	pi.on("tool_result", (event: ToolResultEvent) => {
		if (!currentLayout) return;

		// Reset idle timer on any tool activity
		resetIdleTimer();

		// Only track veil_* custom tools for cat state
		const catState = VEIL_TOOL_STATES[event.toolName] ?? null;
		if (!catState) return;

		// Extract detail from tool result
		const textContent = Array.isArray(event.content) ? event.content.find((c) => c.type === "text") : null;
		const detail = textContent && "text" in textContent ? textContent.text?.slice(0, 30) : undefined;

		// Emit memory event to update cat widget
		currentLayout.emit({ type: "memory", state: catState, detail });
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const config = loadConfig(ctx.cwd);

		// Subscribe to VeilHarness memory events if available
		let unsubscribeMemory: (() => void) | undefined;
		const harness = (globalThis as any)[VEIL_HARNESS_KEY];
		if (harness?.onMemoryEvent) {
			unsubscribeMemory = harness.onMemoryEvent((event: { type: string; detail?: string }) => {
				if (!currentLayout) return;
				resetIdleTimer();

				const catState = event.type as CatState;
				if (!["sleeping", "watching", "remembering", "learned", "recalled", "conflict"].includes(catState)) {
					return;
				}

				currentLayout.emit({ type: "memory", state: catState, detail: event.detail });
			});
		}

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
					unsubscribeMemory?.();
					currentLayout = null;
					layout.dispose();
				},
			};
		});
	});

	// Wake up cat on user activity
	pi.on("turn_start", () => {
		wakeUp();
	});

	pi.on("session_shutdown", () => {
		if (idleTimer) clearTimeout(idleTimer);
		currentLayout = null;
	});
}
