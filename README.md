# Veil

**Autonomic context for AI agents.** Context that governs itself, so you stop thinking about it.

```bash
curl -sSL https://veil.engrammic.ai/install | sh
```

## What it does

Veil is a coding agent (like Claude Code, Cursor, Aider) with **self-managing context**:

- **Auto-eviction** — stale context fades automatically, no manual cleanup
- **Self-tuning** — learns what matters from its own mistakes (AIMD control)
- **Failure memory** — remembers what didn't work so loops converge instead of grinding
- **Compression** — code, config, and conversations compress intelligently

No LLM in the memory loop. Pure deterministic scoring on the hot path. Model intelligence stays off-path where it can't break things.

## Quick start

```bash
# Install
curl -sSL https://veil.engrammic.ai/install | sh

# Run in any project
cd your-project
veil
```

## Why Veil?

Every coding agent fails the same way:
- **Claude Code** — auto-compaction destroys context; no real cross-session memory
- **Cursor/Windsurf** — silent truncation, stale indexes, "vicious circle" of context loss
- **Aider/Cline/etc.** — one stale markdown file + an LLM summarizer that loops and burns tokens

Veil is different: **two-speed autonomic design**.

| Fast path (reflexes) | Slow path (deliberation) |
|---------------------|-------------------------|
| Deterministic scorer + eviction | Reads event log, writes policy |
| Runs every turn, sub-10ms | Runs between turns, off critical path |
| Never blocks, never flakes | Bad policy is bounded + reversible |

The slow layer never mutates live context — only the rules. That's why it doesn't rot.

## Features

| Feature | Status |
|---------|--------|
| Self-tuning eviction (AIMD) | Done |
| Worldview (structural + behavioral) | Done |
| Failure memory + convergence detection | Done |
| Compression pipeline | Done |
| CLI (`veil` command) | Done |

## Architecture

```
Agent Loop (Pi fork)
    │
    ▼
VeilHarness ──► hooks into tool calls
    │
    ▼
ContextManager ──► scorer, eviction, injection
    │
    ▼
SQLite (warm) ──► local-first, no network
    │
    ▼
Cold tier (optional) ──► cross-session, cross-device
```

## Development

```bash
git clone https://github.com/engrammic/veil
cd veil
npm install --ignore-scripts
npm run build
./veil-test.sh
```

See [CLAUDE.md](CLAUDE.md) for architecture details.

## Documentation

- [Design doc](context/DESIGN-autonomic.md) — full technical design
- [Roadmap](context/ROADMAP.md) — what's done, what's next
- [Alignment](alignment/) — vision, manifesto, principles

## Credits

Built on [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner. MIT licensed.

Part of the [Engrammic](https://engrammic.ai) ecosystem.
