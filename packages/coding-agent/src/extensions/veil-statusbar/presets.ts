export interface PresetConfig {
	left: string[];
	right: string[];
}

export const PRESETS: Record<string, PresetConfig> = {
	full: {
		left: ["project", "context-bar", "tokens", "model", "mode"],
		right: ["cat"],
	},
	minimal: {
		left: ["model", "context-bar"],
		right: [],
	},
	demo: {
		left: ["project", "model"],
		right: ["cat"],
	},
};

export function getPreset(name: string): PresetConfig | undefined {
	return PRESETS[name];
}

export function getDefaultPreset(): PresetConfig {
	return PRESETS.full;
}
