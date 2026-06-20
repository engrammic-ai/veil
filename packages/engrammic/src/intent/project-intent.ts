import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectIntentFile } from "./intent-types.ts";

const INTENT_FILE = ".veil/intent.json";
const HISTORY_MAX = 10;

export function generateIntentId(): string {
	return `intent_${randomBytes(6).toString("base64url").slice(0, 8)}`;
}

export async function loadProjectIntent(projectRoot: string): Promise<ProjectIntentFile | null> {
	const filePath = join(projectRoot, INTENT_FILE);
	try {
		const raw = await readFile(filePath, "utf-8");
		return JSON.parse(raw) as ProjectIntentFile;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		console.warn(`[intent] Failed to parse ${filePath}:`, err);
		return null;
	}
}

export async function saveProjectIntent(projectRoot: string, data: ProjectIntentFile): Promise<void> {
	const dirPath = join(projectRoot, ".veil");
	await mkdir(dirPath, { recursive: true });

	const pruned: ProjectIntentFile = {
		...data,
		history: data.history.slice(-HISTORY_MAX),
	};

	const filePath = join(projectRoot, INTENT_FILE);
	await writeFile(filePath, JSON.stringify(pruned, null, 2), "utf-8");
}
