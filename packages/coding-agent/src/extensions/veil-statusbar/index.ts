import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { StatusBarLayout } from "./layout.ts";
import type { WidgetContext } from "./types.ts";
import { CatWidget } from "./widgets/cat.ts";
import { ProjectWidget } from "./widgets/project.ts";

export default function veilStatusbar(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((_tui, theme, footerData) => {
			const layout = new StatusBarLayout();

			const widgetCtx: WidgetContext = {
				sessionManager: ctx.sessionManager,
				footerData,
				theme,
			};

			const catWidget = new CatWidget();
			catWidget.init({}, widgetCtx);
			layout.addWidget(catWidget, "right");

			const projectWidget = new ProjectWidget();
			projectWidget.init({}, widgetCtx);
			layout.addWidget(projectWidget, "left");

			return {
				render: (width: number) => layout.render(width),
				invalidate: () => layout.invalidate(),
				dispose: () => layout.dispose(),
			};
		});
	});
}
