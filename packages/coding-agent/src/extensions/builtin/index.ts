/**
 * Builtin extensions that are loaded by default.
 *
 * These extensions provide core functionality that most users will want.
 * They can be disabled via configuration if needed.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import veilStatusbar from "../veil-statusbar/index.ts";
import planModeExtension from "./plan-mode.ts";

/** All builtin extension factories */
export const builtinExtensions: ExtensionFactory[] = [planModeExtension, veilStatusbar];

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
