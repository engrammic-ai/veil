/**
 * Dependency change extractor - captures package installs.
 */

import type { Extractor, ExtractorContext, ExtractorResult } from "./types.ts";

function extractPackageNames(command: string, _output: string): string[] {
	const packages: string[] = [];

	const npmMatch = command.match(/npm\s+(?:install|add|i)\s+(.+)/);
	if (npmMatch) {
		packages.push(...npmMatch[1].split(/\s+/).filter((p) => !p.startsWith("-")));
	}

	const yarnMatch = command.match(/yarn\s+add\s+(.+)/);
	if (yarnMatch) {
		packages.push(...yarnMatch[1].split(/\s+/).filter((p) => !p.startsWith("-")));
	}

	const pnpmMatch = command.match(/pnpm\s+add\s+(.+)/);
	if (pnpmMatch) {
		packages.push(...pnpmMatch[1].split(/\s+/).filter((p) => !p.startsWith("-")));
	}

	const pipMatch = command.match(/pip\s+install\s+(.+)/);
	if (pipMatch) {
		packages.push(...pipMatch[1].split(/\s+/).filter((p) => !p.startsWith("-")));
	}

	const cargoMatch = command.match(/cargo\s+add\s+(.+)/);
	if (cargoMatch) {
		packages.push(...cargoMatch[1].split(/\s+/).filter((p) => !p.startsWith("-")));
	}

	return packages.map((p) => p.replace(/@[\d.]+$/, ""));
}

export const depsExtractor: Extractor = (ctx: ExtractorContext): ExtractorResult => {
	const { command } = ctx.args;
	const cmdStr = String(command ?? "");
	const outcome = ctx.isError ? "FAILED" : "OK";

	const packages = extractPackageNames(cmdStr, ctx.content);

	if (packages.length === 0) {
		return { text: "", skipCapture: true };
	}

	return {
		text: `[Deps ${outcome}] ${packages.join(", ")}`,
		extraTags: ["deps", ...packages.map((p) => `pkg:${p}`)],
		cognitiveWeight: outcome === "OK" ? 0.2 : -0.3,
	};
};
