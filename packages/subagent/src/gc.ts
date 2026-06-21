import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupOrphanedChildDbs(parentDbPath: string, maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
	const childrenDir = `${parentDbPath}.children`;

	if (!fs.existsSync(childrenDir)) {
		return 0;
	}

	let removed = 0;
	const now = Date.now();

	for (const file of fs.readdirSync(childrenDir)) {
		// Only process .db files
		if (!file.endsWith(".db")) continue;

		const filePath = path.join(childrenDir, file);

		try {
			const stat = fs.statSync(filePath);
			if (now - stat.mtimeMs > maxAgeMs) {
				fs.rmSync(filePath, { force: true });
				// Also remove SQLite WAL/SHM files
				fs.rmSync(`${filePath}-shm`, { force: true });
				fs.rmSync(`${filePath}-wal`, { force: true });
				removed++;
			}
		} catch {
			// Ignore errors for individual files
		}
	}

	return removed;
}
