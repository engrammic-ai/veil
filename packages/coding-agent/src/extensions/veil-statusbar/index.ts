import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { loadConfig } from "./config.ts";
import { StatusBarLayout } from "./layout.ts";
import type { StatusBarWidget, WidgetContext } from "./types.ts";
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

export default function veilStatusbar(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		const config = loadConfig(ctx.cwd);

		ctx.ui.setFooter((_tui, theme, footerData) => {
			const layout = new StatusBarLayout();

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
					layout.dispose();
				},
			};
		});
	});
}
