import { visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig, StatusBarWidget, WidgetContext, WidgetEvent } from "./types.ts";

export class StatusBarLayout {
	private leftWidgets: StatusBarWidget[] = [];
	private rightWidgets: StatusBarWidget[] = [];

	load(_config: StatusBarConfig, _ctx: WidgetContext): void {}

	addWidget(widget: StatusBarWidget, side: "left" | "right"): void {
		if (side === "left") {
			this.leftWidgets.push(widget);
		} else {
			this.rightWidgets.push(widget);
		}
	}

	render(width: number): string[] {
		const rightWidth = this.calculateRightWidth();
		const leftWidth = Math.max(0, width - rightWidth - 2);

		const leftLines = this.renderSide(this.leftWidgets, leftWidth);
		const rightLines = this.renderSide(this.rightWidgets, rightWidth);

		const maxLines = Math.max(leftLines.length, rightLines.length);
		const result: string[] = [];

		for (let i = 0; i < maxLines; i++) {
			const left = leftLines[i] || "";
			const right = rightLines[i] || "";
			result.push(this.combineLine(left, right, width));
		}

		return result;
	}

	emit(event: WidgetEvent): void {
		for (const widget of [...this.leftWidgets, ...this.rightWidgets]) {
			widget.update(event);
		}
	}

	getWidget(id: string): StatusBarWidget | undefined {
		return [...this.leftWidgets, ...this.rightWidgets].find((w) => w.id === id);
	}

	invalidate(): void {}

	dispose(): void {
		for (const widget of [...this.leftWidgets, ...this.rightWidgets]) {
			widget.dispose?.();
		}
		this.leftWidgets = [];
		this.rightWidgets = [];
	}

	private calculateRightWidth(): number {
		return this.rightWidgets.length > 0 ? 30 : 0;
	}

	private renderSide(widgets: StatusBarWidget[], width: number): string[] {
		const lines: string[] = [];
		for (const widget of widgets) {
			lines.push(...widget.render(width));
		}
		return lines;
	}

	private combineLine(left: string, right: string, totalWidth: number): string {
		const leftVis = visibleWidth(left);
		const rightVis = visibleWidth(right);
		const gap = Math.max(1, totalWidth - leftVis - rightVis);
		return left + " ".repeat(gap) + right;
	}
}
