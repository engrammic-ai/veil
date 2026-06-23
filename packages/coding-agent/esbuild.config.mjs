import * as esbuild from "esbuild";

// ponytail: bundles workspace packages into one file, externalizes native/external deps
const external = [
	// Bun-specific (dead code in Node, but needs to be external)
	"bun:sqlite",
	// Native modules (can't bundle)
	"better-sqlite3",
	"sqlite-vec",
	// Large ML libs
	"@xenova/transformers",
	"@huggingface/transformers",
	// Optional vector DBs (peer deps)
	"@getzep/zep-cloud",
	"@lancedb/lancedb",
	"chromadb",
	// ponytail: Pi packages are bundled (workspace deps), not external
	// They were external when we depended on upstream npm versions, but now
	// we publish our own versions and need them inlined for bun --compile
	// Other external deps
	"@modelcontextprotocol/sdk",
	"@silvia-odwyer/photon-node",
	"@mariozechner/clipboard",
	"chalk",
	"cross-spawn",
	"diff",
	"glob",
	"highlight.js",
	"hosted-git-info",
	"ignore",
	"jiti",
	"minimatch",
	"proper-lockfile",
	"semver",
	"typebox",
	"undici",
	"yaml",
	"graphology",
	"graphology-pagerank",
	"ulid",
	"fastify",
	// Tree-sitter (native)
	"web-tree-sitter",
	"tree-sitter-go",
	"tree-sitter-javascript",
	"tree-sitter-python",
	"tree-sitter-rust",
	"tree-sitter-typescript",
];

import { renameSync, unlinkSync, existsSync } from "fs";

// Bundle main cli
await esbuild.build({
	entryPoints: ["dist/cli.js"],
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	outfile: "dist/cli.bundled.js",
	sourcemap: true,
	external,
});
unlinkSync("dist/cli.js");
renameSync("dist/cli.bundled.js", "dist/cli.js");
renameSync("dist/cli.bundled.js.map", "dist/cli.js.map");

// Bundle bun-specific entrypoints (they import from pi-ai/compat etc)
for (const file of ["dist/bun/register-bedrock.js", "dist/bun/restore-sandbox-env.js"]) {
	if (!existsSync(file)) continue;
	const out = file.replace(".js", ".bundled.js");
	await esbuild.build({
		entryPoints: [file],
		bundle: true,
		platform: "node",
		target: "node22",
		format: "esm",
		outfile: out,
		sourcemap: true,
		external,
	});
	unlinkSync(file);
	renameSync(out, file);
	if (existsSync(out + ".map")) renameSync(out + ".map", file + ".map");
}

console.log("Bundled dist/cli.js (workspace packages inlined)");
