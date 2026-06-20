/**
 * Builtin extensions that are loaded by default.
 *
 * These extensions provide core functionality that most users will want.
 * They can be disabled via configuration if needed.
 */

// Bundled extensions (previously installed via `pi install`)
import confirmDestructive from "../../../bundled-extensions/confirm-destructive.ts";
import gitCheckpoint from "../../../bundled-extensions/git-checkpoint.ts";
import handoff from "../../../bundled-extensions/handoff.ts";
import notify from "../../../bundled-extensions/notify.ts";
import preset from "../../../bundled-extensions/preset.ts";
import titlebarSpinner from "../../../bundled-extensions/titlebar-spinner.ts";
import todo from "../../../bundled-extensions/todo.ts";
import tools from "../../../bundled-extensions/tools.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import veilStatusbar from "../veil-statusbar/index.ts";
import brainstormModeExtension from "./brainstorm-mode.ts";
import intentTrackingExtension from "./intent-tracking.ts";
import planModeExtension from "./plan-mode.ts";

/** All builtin extension factories */
export const builtinExtensions: ExtensionFactory[] = [
	// Core Veil extensions
	brainstormModeExtension,
	intentTrackingExtension,
	planModeExtension,
	veilStatusbar,
	// Bundled extensions
	confirmDestructive,
	gitCheckpoint,
	handoff,
	notify,
	preset,
	titlebarSpinner,
	todo,
	tools,
];

/** Get builtin extension factories, optionally filtered by disabled list */
export function getBuiltinExtensions(disabled?: string[]): ExtensionFactory[] {
	if (!disabled || disabled.length === 0) {
		return builtinExtensions;
	}

	const disabledSet = new Set(disabled.map((d) => d.toLowerCase()));

	return builtinExtensions.filter((ext) => {
		// Use the function name to identify the extension
		const name = ext.name?.toLowerCase() || "";
		return !disabledSet.has(name) && !disabledSet.has(name.replace("extension", ""));
	});
}
