# Veil

Context-aware agent harness. Memory that fades so you don't have to think about it.

> Fork of [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner, adding integrated context management and episodic memory.

## What Veil Does

- **Dynamic context loading** — load what's relevant, not everything
- **Heuristic eviction** — stale context fades automatically, no LLM calls
- **Episodic memory** — sessions become episodes, episodes become knowledge  
- **Rot prevention** — old memories decay gracefully, not abruptly

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

Veil is built on top of [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner and the Earendil team. Thank you for making Pi open source.
