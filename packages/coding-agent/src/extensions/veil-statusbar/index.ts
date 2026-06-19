import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../core/extensions/types.ts";

export default function veilStatusbar(pi: ExtensionAPI) {
	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((_tui, _theme, _footerData) => ({
			render: (_width: number) => ["[veil-statusbar placeholder]"],
			invalidate: () => {},
			dispose: () => {},
		}));
	});
}
