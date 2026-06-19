import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultPreset, getPreset, type PresetConfig } from "./presets.ts";
import type { StatusBarConfig } from "./types.ts";

export interface ResolvedConfig {
	left: string[];
	right: string[];
	widgetConfigs: Record<string, Record<string, unknown>>;
}

function loadJsonFile(filePath: string): StatusBarConfig | null {
	try {
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf-8");
			return JSON.parse(content) as StatusBarConfig;
		}
	} catch {
		// Ignore parse errors, use defaults
	}
	return null;
}

export function loadConfig(cwd: string): ResolvedConfig {
	const userConfigPath = path.join(os.homedir(), ".config", "veil", "statusbar.json");
	const userConfig = loadJsonFile(userConfigPath);

	const projectConfigPath = path.join(cwd, ".veil", "statusbar.json");
	const projectConfig = loadJsonFile(projectConfigPath);

	const merged: StatusBarConfig = { ...userConfig, ...projectConfig };

	return resolveConfig(merged);
}

function resolveConfig(config: StatusBarConfig): ResolvedConfig {
	let base: PresetConfig;
	if (config.preset) {
		base = getPreset(config.preset) ?? getDefaultPreset();
	} else {
		base = getDefaultPreset();
	}

	let left = config.left ?? base.left;
	let right = config.right ?? base.right;

	if (config.hide && config.hide.length > 0) {
		const hideSet = new Set(config.hide);
		left = left.filter((id) => !hideSet.has(id));
		right = right.filter((id) => !hideSet.has(id));
	}

	return {
		left,
		right,
		widgetConfigs: config.widgets ?? {},
	};
}
