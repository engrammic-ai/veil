/**
 * Permission mode management for tool execution approval.
 */

export type PermissionMode = "auto-accept" | "default" | "cautious";

const PERMISSION_MODES: PermissionMode[] = ["auto-accept", "default", "cautious"];

const DANGEROUS_TOOLS = new Set([
	"bash",
	"write",
	"edit",
	"notebook_edit",
	"mcp_tool",
]);

const SAFE_TOOLS = new Set([
	"read",
	"grep",
	"glob",
	"list_directory",
	"search",
]);

export class PermissionManager {
	private mode: PermissionMode = "default";
	private sessionAllowed = new Set<string>();
	private listeners = new Set<(mode: PermissionMode) => void>();

	getMode(): PermissionMode {
		return this.mode;
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
		this.notifyListeners();
	}

	cycleMode(): PermissionMode {
		const idx = PERMISSION_MODES.indexOf(this.mode);
		const nextIdx = (idx + 1) % PERMISSION_MODES.length;
		this.mode = PERMISSION_MODES[nextIdx];
		this.notifyListeners();
		return this.mode;
	}

	shouldPrompt(toolName: string): boolean {
		if (this.mode === "auto-accept") {
			return false;
		}

		if (this.sessionAllowed.has(toolName)) {
			return false;
		}

		if (this.mode === "cautious") {
			return !SAFE_TOOLS.has(toolName);
		}

		return DANGEROUS_TOOLS.has(toolName) || toolName.startsWith("mcp__");
	}

	allowForSession(toolName: string): void {
		this.sessionAllowed.add(toolName);
	}

	resetSessionAllowances(): void {
		this.sessionAllowed.clear();
	}

	onModeChange(listener: (mode: PermissionMode) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			listener(this.mode);
		}
	}
}
