# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Veil is a context-aware agent harness with episodic memory, forked from pi-mono. It adds dynamic context loading and heuristic eviction to the Pi agent framework.

## Commands

```bash
# Install (skip postinstall scripts from Pi)
npm install --ignore-scripts

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
tui → ai → agent → coding-agent
```

| Package | Purpose |
|---------|---------|
| `packages/tui` | Terminal UI primitives (node:test) |
| `packages/ai` | Multi-provider LLM API (vitest) |
| `packages/agent` | Agent runtime with tool execution (vitest) |
| `packages/coding-agent` | CLI entry point, session management (vitest) |
| `packages/engrammic` | Memory subsystem integration |
| `packages/context` | Context manager (NEW, in development) |

The coding-agent CLI is the main entry point (`pi` command when installed, `./veil-test.sh` from sources).

## Context Files

Local context files live in `context/` (gitignored):
- `context/distribution.md` - marketing/community distribution channels

## Git Commits

Do not add Co-Authored-By lines to commit messages.
