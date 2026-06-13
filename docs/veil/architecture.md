# Veil Architecture

Fork of Pi with integrated context management.

## What Veil Adds to Pi

Pi provides:
- Agent loop (packages/agent)
- LLM API (packages/ai)
- CLI + extensions (packages/coding-agent)
- TUI (packages/tui)

Veil adds:
- Context Manager (integrated into agent loop)
- Heuristic eviction (no LLM calls)
- Episodic memory with decay
- SQLite warm cache
- KG adapter for cold storage

## Modified Pi Components

| Pi Component | Veil Modification |
|--------------|-------------------|
| `packages/agent/src/agent.ts` | Add context budget tracking |
| `packages/agent/src/agent-loop.ts` | Hook eviction into turn cycle |
| `packages/coding-agent/src/core/agent-session.ts` | Replace compaction with Veil's |
| `packages/coding-agent/src/core/compaction/` | New eviction-based compaction |

## New Veil Components

```
packages/
├── context/                    # NEW: Context management core
│   ├── src/
│   │   ├── manager.ts          # Window manager, loader/unloader
│   │   ├── scorer.ts           # Heuristic relevance scoring
│   │   ├── decay.ts            # Rot prevention
│   │   └── types.ts
│   └── package.json
├── memory/                     # NEW: Memory subsystem
│   ├── src/
│   │   ├── episodic.ts         # Episode store
│   │   ├── sqlite-cache.ts     # Warm cache
│   │   ├── kg-adapter.ts       # Cold storage interface
│   │   └── types.ts
│   └── package.json
```

## Context Flow

```
User input
    │
    ▼
┌─────────────────────────┐
│ before_agent_start hook │ ◄── Inject relevant memories
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Agent Loop (Pi)         │
│   ┌───────────────────┐ │
│   │ context hook      │ │ ◄── Per-turn eviction check
│   └───────────────────┘ │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ turn_end hook           │ ◄── Store episode, update decay
└─────────────────────────┘
```

## Eviction Strategy

Score = `0.3×recency + 0.2×frequency + 0.3×relevance + 0.15×structural + 0.15×cognitive_weight`

Cascade:
1. Hard evict: >2h untouched + single access
2. Soft evict: score < 0.3, summarize if large
3. Demote to cold: warm items >24h → KG
4. Rot sweep: weekly confidence decay

## Episode Lifecycle

```
FRESH (0-24h) → WARM (1-7d) → COOLING (7-30d) → COLD (30d+) → ARCHIVED
```
