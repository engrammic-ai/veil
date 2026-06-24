# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Veil is a context-aware agent harness with episodic memory, **forked from [Pi](https://github.com/badlogic/pi-mono)**. It adds dynamic context loading and heuristic eviction to the Pi agent framework.

**Branding note:** The codebase retains Pi's internal package names, CLI commands (`pi`), and documentation references. When explaining Veil to users, clarify it's a Pi fork — the extension system, skills, tools, and APIs are inherited from Pi. Don't rebrand these in responses; just note the fork relationship.

## Commands

```bash
# Install (native modules like better-sqlite3 will be built automatically)
npm install

# Build all packages (order matters: tui → ai → agent → coding-agent)
npm run build

# Run from sources
./veil-test.sh

# Lint and type check
npm run check

# Run all tests
npm run test

# Run tests in a single package
cd packages/ai && npm test
cd packages/agent && npm test
cd packages/coding-agent && npm test
```

## Architecture

Monorepo with npm workspaces. Packages have strict build order due to dependencies:

```
tui → ai → veil-embedder → veil-memory → engrammic → agent → coding-agent
```

| Package | Purpose |
|---------|---------|
| `packages/tui` | Terminal UI primitives (node:test) |
| `packages/ai` | Multi-provider LLM API (vitest) |
| `packages/veil-embedder` | Local embedding service (Xenova transformers + Ollama) |
| `packages/veil-memory` | Cold storage with FSRS decay, sqlite-vec, version vectors |
| `packages/engrammic` | Context manager: VeilHarness + 3-tier Hot/Warm/Cold memory |
| `packages/agent` | Agent runtime with tool execution (vitest) |
| `packages/coding-agent` | CLI entry point, session management (vitest) |

The coding-agent CLI is the main entry point (`pi` command when installed, `./veil-test.sh` from sources).

## Context Files

Local context files live in `context/` (gitignored):
- `context/distribution.md` - marketing/community distribution channels

## Git Commits

Do not add Co-Authored-By lines to commit messages.
