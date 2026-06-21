# Engrammic Harness

Context management harness for LLM coding agents with KG-backed episodic memory.

## Vision

A standalone harness (forking Pi Agents as base) with:
- Dynamic context loading/unloading
- Episodic memory with rot prevention
- Heuristic-based eviction (no LLM calls for memory ops)
- On-device/lightweight operation

## Architecture

```
┌─────────────────────────────────────────┐
│  Active Context Window (hot)            │
│  - Current task + hydrated pointers     │
│  - Budget: ~60% of token limit          │
└──────────────┬──────────────────────────┘
               │ pointer refs
┌──────────────▼──────────────────────────┐
│  Working Memory (warm) - SQLite         │
│  - Recent episodes, active file chunks  │
│  - Indexed by recency + access count    │
└──────────────┬──────────────────────────┘
               │ KG queries
┌──────────────▼──────────────────────────┐
│  Long-term Memory (cold) - KG           │
│  - Bi-temporal facts, codebase map      │
│  - Episodic summaries with decay scores │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Conversation Archive - SQLite          │
│  - Evicted turns with classification    │
│  - Decisions/corrections preserved      │
│  - Searchable via /history command      │
└─────────────────────────────────────────┘
```

### Conversation Eviction

Separate from memory eviction, the harness also manages conversation history:

- **Turn classification**: Each turn tagged as decision/exploration/action/correction/status
- **Protected window**: Last 12 turns never evicted
- **Reference detection**: Embedding similarity prevents evicting referenced content
- **Stub replacement**: Evicted turns replaced with summaries pointing to archive
- **Feedback learning**: Detects when eviction removed something important

## Key Design Decisions

1. **SQLite as warm cache** - Fast, on-device, no dependencies
2. **Pointer-not-content in context** - Stubs like `[FILE:src/auth.ts:45-80]` hydrate on demand
3. **Hook-based triggers** - Pre/post events for tool calls drive context refresh
4. **Agent self-triage** - At checkpoints, agent decides what to keep/compress

## Docs

- [Research Findings](./research-findings.md) - Literature review and existing solutions
- [Eviction Strategy](./eviction-strategy.md) - Heuristic cascade for memory management
- [Intent Tracking](./SPEC-intent-tracking.md) - Goal alignment + conversation eviction
- [Roadmap](./roadmap.md) - Prototype phases and next steps

## Licensing

Pi Agents is MIT licensed - permissive for forking.
