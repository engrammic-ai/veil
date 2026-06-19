import { Container, type Focusable, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export type ToolApprovalResult = "allow" | "deny" | "allow-session";

export interface ToolApprovalOptions {
	toolName: string;
	argsPreview: string;
}

export class ToolApprovalComponent extends Container implements Focusable {
	private resolver?: (result: ToolApprovalResult) => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(options: ToolApprovalOptions) {
		super();

		const { toolName, argsPreview } = options;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("warning", theme.bold("Tool Approval Required")), 1, 0));
		this.addChild(new Text("", 0, 0));
		this.addChild(new Text(`Tool: ${theme.fg("accent", toolName)}`, 1, 0));

		if (argsPreview) {
			const preview = argsPreview.length > 60 ? `${argsPreview.slice(0, 57)}...` : argsPreview;
			this.addChild(new Text(`Args: ${theme.fg("muted", preview)}`, 1, 0));
		}

		this.addChild(new Text("", 0, 0));
		this.addChild(
			new Text(
				`${theme.fg("success", "[y]")} Allow  ${theme.fg("error", "[n]")} Deny  ${theme.fg("accent", "[a]")} Allow for session  ${theme.fg("muted", "[Esc]")} Cancel`,
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}

	waitForResult(): Promise<ToolApprovalResult> {
		return new Promise((resolve) => {
			this.resolver = resolve;
		});
	}

	handleKey(key: string): boolean {
		if (!this.resolver) return false;

		switch (key.toLowerCase()) {
			case "y":
				this.resolver("allow");
				this.resolver = undefined;
				return true;
			case "n":
			case "escape":
				this.resolver("deny");
				this.resolver = undefined;
				return true;
			case "a":
				this.resolver("allow-session");
				this.resolver = undefined;
				return true;
		}
		return false;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}
