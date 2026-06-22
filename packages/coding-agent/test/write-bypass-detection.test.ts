/**
 * write-bypass-detection.test.ts — Tests for bash write-bypass pattern detection
 * and permission prompting.
 *
 * These tests verify that bash commands which bypass the write/edit tools
 * (e.g., echo >, cat << EOF, sed -i) are properly detected and trigger
 * permission prompts with appropriate warnings.
 */

import { describe, expect, it } from "vitest";
import { detectWriteBypass } from "../src/core/permission-manager.ts";

describe("detectWriteBypass", () => {
	describe("should detect write-bypass patterns", () => {
		const SHOULD_DETECT = [
			// echo/printf redirects
			["echo foo > file.txt", "echo with >"],
			["echo 'hello world' > output.txt", "echo with quoted string"],
			['echo "hello" >> file.txt', "echo with >>"],
			["printf '%s' > out.txt", "printf with >"],
			["printf 'data' >> log.txt", "printf with >>"],

			// heredocs
			["cat << EOF > file.txt", "cat heredoc with >"],
			["cat <<EOF > file.txt", "cat heredoc no space"],
			['cat << "EOF" > file', "cat heredoc quoted delimiter"],
			["cat <<'EOF' > file", "cat heredoc single-quoted"],
			["cat << END > file.txt", "cat heredoc END"],
			["cat <<-EOF > file.txt", "cat heredoc with dash"],

			// in-place editing
			["sed -i s/foo/bar/ file.txt", "sed -i"],
			["sed -i.bak s/foo/bar/ file.txt", "sed -i with backup"],
			["sed -n -i s/foo/bar/ file.txt", "sed with flags before -i"],
			["perl -i -pe s/foo/bar/ file.txt", "perl -i"],
			["perl -i.bak -pe s/foo/bar/ file.txt", "perl -i with backup"],

			// tee
			["ls | tee output.txt", "pipe to tee"],
			["echo foo | tee -a log.txt", "tee append"],
			["cat file | tee copy.txt", "cat to tee"],

			// awk redirects
			['awk "{print}" > out.txt', "awk with >"],
			["awk '/pattern/ {print}' file.txt > filtered.txt", "awk filter with >"],
		];

		for (const [command, description] of SHOULD_DETECT) {
			it(`detects: ${description}`, () => {
				const result = detectWriteBypass(command);
				expect(result).toBeDefined();
				expect(typeof result).toBe("string");
				expect(result!.length).toBeGreaterThan(0);
			});
		}
	});

	describe("should NOT detect safe commands", () => {
		const SHOULD_NOT_DETECT = [
			// read-only commands
			["ls -la", "ls"],
			["cat file.txt", "cat read"],
			["grep foo bar.txt", "grep"],
			["find . -name '*.ts'", "find"],
			["head -n 10 file.txt", "head"],
			["tail -f log.txt", "tail"],

			// echo without redirect
			["echo hello", "echo to stdout"],
			["echo $PATH", "echo variable"],

			// safe uses
			["git status", "git status"],
			["npm install", "npm install"],
			["node script.js", "node"],
			["python script.py", "python"],

			// redirects to /dev/null (safe)
			["command 2>/dev/null", "stderr to null"],
			["command >/dev/null 2>&1", "stdout to null"],
		];

		for (const [command, description] of SHOULD_NOT_DETECT) {
			it(`allows: ${description}`, () => {
				const result = detectWriteBypass(command);
				expect(result).toBeUndefined();
			});
		}
	});

	describe("warning messages", () => {
		it("suggests write tool for echo redirects", () => {
			const result = detectWriteBypass("echo foo > file.txt");
			expect(result).toContain("write");
		});

		it("suggests edit tool for sed -i", () => {
			const result = detectWriteBypass("sed -i s/a/b/ file.txt");
			expect(result).toContain("edit");
		});

		it("suggests write tool for heredocs", () => {
			const result = detectWriteBypass("cat << EOF > file.txt");
			expect(result).toContain("write");
		});

		it("suggests write tool for tee", () => {
			const result = detectWriteBypass("ls | tee out.txt");
			expect(result).toContain("write");
		});
	});
});
