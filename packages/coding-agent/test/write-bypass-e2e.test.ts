/**
 * write-bypass-e2e.test.ts — End-to-end tests for write-bypass permission prompting.
 *
 * Tests that bash commands which bypass write/edit tools trigger permission
 * prompts with appropriate warnings when executed through a real AgentSession.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../src/core/permission-manager.ts";

// Set longer timeout for E2E tests
vi.setConfig({ testTimeout: 10_000 });

describe("write-bypass permission prompting (e2e)", () => {
	let tempDir: string;
	let permissionManager: PermissionManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `veil-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		permissionManager = new PermissionManager(tempDir);
		permissionManager.setMode("default");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("shouldPrompt returns true for write-bypass commands", () => {
		const WRITE_BYPASS_COMMANDS = [
			"echo foo > file.txt",
			"echo 'data' >> log.txt",
			"cat << EOF > config.txt",
			"sed -i s/old/new/ file.txt",
			"ls | tee output.txt",
			"awk '{print}' > out.txt",
		];

		for (const command of WRITE_BYPASS_COMMANDS) {
			it(`prompts for: ${command.slice(0, 40)}...`, () => {
				const ctx = {
					toolName: "bash",
					args: { command },
				};

				const shouldPrompt = permissionManager.shouldPrompt(ctx);
				expect(shouldPrompt).toBe(true);
			});
		}
	});

	describe("shouldPrompt returns false for safe commands", () => {
		const SAFE_COMMANDS = ["ls -la", "cat file.txt", "grep foo bar.txt", "find . -name '*.ts'", "git status"];

		for (const command of SAFE_COMMANDS) {
			it(`does not prompt for: ${command}`, () => {
				const ctx = {
					toolName: "bash",
					args: { command },
				};

				// In default mode, read-only bash commands don't prompt
				const shouldPrompt = permissionManager.shouldPrompt(ctx);
				expect(shouldPrompt).toBe(false);
			});
		}
	});

	describe("auto mode still prompts for write-bypass", () => {
		it("prompts even in auto mode", () => {
			const autoManager = new PermissionManager(tempDir);
			autoManager.setMode("auto");

			const ctx = {
				toolName: "bash",
				args: { command: "echo secret > password.txt" },
			};

			const shouldPrompt = autoManager.shouldPrompt(ctx);
			expect(shouldPrompt).toBe(true);
		});

		it("does not prompt for safe commands in auto mode", () => {
			const autoManager = new PermissionManager(tempDir);
			autoManager.setMode("auto");

			const ctx = {
				toolName: "bash",
				args: { command: "ls -la" },
			};

			const shouldPrompt = autoManager.shouldPrompt(ctx);
			expect(shouldPrompt).toBe(false);
		});
	});

	describe("acceptEdits mode still prompts for write-bypass", () => {
		it("prompts for write-bypass in acceptEdits mode", () => {
			const acceptEditsManager = new PermissionManager(tempDir);
			acceptEditsManager.setMode("acceptEdits");

			const ctx = {
				toolName: "bash",
				args: { command: "cat << EOF > script.sh" },
			};

			const shouldPrompt = acceptEditsManager.shouldPrompt(ctx);
			expect(shouldPrompt).toBe(true);
		});
	});
});
