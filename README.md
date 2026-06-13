# Veil

Context-aware agent harness. Memory that fades so you don't have to think about it.

Part of the [Engrammic](https://engrammic.ai) ecosystem.

> Fork of [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner, adding integrated context management and episodic memory.

## What Veil Does

- **Dynamic context loading** — load what's relevant, not everything
- **Heuristic eviction** — stale context fades automatically, no LLM calls
- **Episodic memory** — sessions become episodes, episodes become knowledge  
- **Rot prevention** — old memories decay gracefully, not abruptly

## Why Veil?

See the [alignment docs](alignment/) for the full picture:

- **[VISION.md](alignment/VISION.md)** — The problem, the insight, where we're going
- **[MANIFESTO.md](alignment/MANIFESTO.md)** — Philosophical stance on memory and forgetting
- **[PRINCIPLES.md](alignment/PRINCIPLES.md)** — Design decisions and constraints

## Packages

| Package | Description |
|---------|-------------|
| **[@engrammic/veil-ai](packages/ai)** | Unified multi-provider LLM API (from Pi) |
| **[@engrammic/veil-agent](packages/agent)** | Agent runtime with context management |
| **[@engrammic/veil-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@engrammic/veil-tui](packages/tui)** | Terminal UI library |
| **[@engrammic/veil-context](packages/context)** | Context manager (NEW) |
| **[@engrammic/veil-memory](packages/memory)** | Memory subsystem (NEW) |

## Architecture

```
┌─────────────────────────────────────────┐
│              VEIL HARNESS               │
│  ┌───────────────────────────────────┐  │
│  │  Agent Loop (from Pi)             │  │
│  └───────────────┬───────────────────┘  │
│                  │                       │
│  ┌───────────────▼───────────────────┐  │
│  │  Context Manager (Veil)           │  │
│  │  - Eviction, scoring, loading     │  │
│  └───────────────┬───────────────────┘  │
│                  │                       │
│  ┌───────────────▼───────────────────┐  │
│  │  Memory (SQLite + KG adapter)     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Status

Early development. Building in public.

## Development

```bash
npm install --ignore-scripts
npm run build
./veil-test.sh  # Run veil from sources
```

## License

MIT — See [LICENSE](LICENSE) for Pi attribution.

## Credits

Veil is built on top of [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner and the Earendil team. tysm for making Pi open source <3

## Links

- [Engrammic](https://engrammic.ai) — Epistemic memory for AI agents
- [Pi (upstream)](https://github.com/badlogic/pi-mono) — The coding agent Veil is built on
