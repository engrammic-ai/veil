import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupOrphanedChildDbs } from "./gc.ts";

describe("cleanupOrphanedChildDbs", () => {
	const testDir = path.join(os.tmpdir(), `veil-gc-test-${Date.now()}`);
	const childrenDir = `${testDir}.children`;

	beforeEach(() => {
		fs.mkdirSync(childrenDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
		fs.rmSync(childrenDir, { recursive: true, force: true });
	});

	it("removes DBs older than maxAge", () => {
		const oldDb = path.join(childrenDir, "old-session.db");
		fs.writeFileSync(oldDb, "test");

		// Set mtime to 25 hours ago
		const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
		fs.utimesSync(oldDb, oldTime, oldTime);

		const removed = cleanupOrphanedChildDbs(testDir, 24 * 60 * 60 * 1000);

		expect(removed).toBe(1);
		expect(fs.existsSync(oldDb)).toBe(false);
	});

	it("keeps DBs younger than maxAge", () => {
		const newDb = path.join(childrenDir, "new-session.db");
		fs.writeFileSync(newDb, "test");

		const removed = cleanupOrphanedChildDbs(testDir, 24 * 60 * 60 * 1000);

		expect(removed).toBe(0);
		expect(fs.existsSync(newDb)).toBe(true);
	});

	it("returns 0 if children dir does not exist", () => {
		fs.rmSync(childrenDir, { recursive: true, force: true });
		const removed = cleanupOrphanedChildDbs(testDir);
		expect(removed).toBe(0);
	});

	it("removes WAL and SHM files with DB", () => {
		const oldDb = path.join(childrenDir, "old-session.db");
		fs.writeFileSync(oldDb, "test");
		fs.writeFileSync(`${oldDb}-wal`, "wal");
		fs.writeFileSync(`${oldDb}-shm`, "shm");

		const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
		fs.utimesSync(oldDb, oldTime, oldTime);

		cleanupOrphanedChildDbs(testDir, 24 * 60 * 60 * 1000);

		expect(fs.existsSync(oldDb)).toBe(false);
		expect(fs.existsSync(`${oldDb}-wal`)).toBe(false);
		expect(fs.existsSync(`${oldDb}-shm`)).toBe(false);
	});
});
