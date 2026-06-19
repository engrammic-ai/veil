import type { ExtensionAPI } from "../../core/extensions/types.ts";

export default function veilStatusbar(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((_tui, _theme, _footerData) => ({
			render: (_width: number) => ["[veil-statusbar placeholder]"],
			invalidate: () => {},
			dispose: () => {},
		}));
	});
}
