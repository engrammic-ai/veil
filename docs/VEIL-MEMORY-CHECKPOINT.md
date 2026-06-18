# Veil Memory Implementation Checkpoint

> Date: 2026-06-18  
> Status: MVP Phase 1 Complete

---

## Summary

Created `packages/veil-memory/` — the FSRS-powered memory companion ("the cat") for AI agents. This implements the core storage, decay, and retrieval system from `VEIL-MEMORY-SPEC.md`.

---

## Completed

### Package Structure

```
packages/veil-memory/
  src/
    index.ts              # Main exports
    types.ts              # All type definitions
    store.ts              # MemoryStore class (main API)
    fsrs.ts               # FSRS decay engine
    version-vector.ts     # Causal ordering logic
    schema.ts             # SQL schema + migrations
    embedder/
      index.ts            # Embedder interface
      ollama.ts           # Ollama nomic-embed-text
    ui/
      cat.ts              # ASCII cat widget
  test/
    fsrs.test.ts          # 16 tests
    version-vector.test.ts # 17 tests
  package.json
  tsconfig.json
  vitest.config.ts
```

### Core Features

| Feature | Status | Notes |
|---------|--------|-------|
| Event-sourced schema | Done | Append-only events, projection table |
| FSRS decay | Done | R=0.9 at t=S calibration verified |
| Version vectors | Done | dominates/merge/increment/concurrent |
| sqlite-vec integration | Done | Vector search via rowid mapping |
| Bi-temporal storage | Done | valid_from + recorded_at |
| Source tier tracking | Done | authoritative/validated/observed/inferred |
| Retrievability tiers | Done | hot/warm/cold filtering |
| Memory operations | Done | learn/remember/skill/recall/forget/history |
| Conflict detection | Done | VV comparison on write |
| Conflict listing | Done | conflicts() method |
| Cat widget | Done | 6 states, unicode/ascii modes |
| Ollama embedder | Done | nomic-embed-text v1.5 |
| Tests | Done | 33 tests passing |
| Build | Done | TypeScript compiles clean |

### Key Implementation Details

**FSRS Constants (conservative)**
```typescript
FACTOR: 19/81,     // yields R=0.9 at t=S
DECAY: -0.5,
GROWTH: 1.0,       // conservative (was exp(3.5) in original FSRS)
DIFF_WEIGHT: 0.5,
S_WEIGHT: 0.2,
R_WEIGHT: 1.5,
```

**Initial Stability by Type**
- Episodic: 0.5 days (fast decay)
- Factual: 1 day
- Procedural: 7 days (skills are expensive)

**Stability Caps**
- Episodic: 30 days
- Factual/Procedural: 365 days

---

## Not Yet Implemented

### MVP Remaining

| Feature | Priority | Notes |
|---------|----------|-------|
| MCP server | High | Tool definitions ready in spec |
| transformers.js fallback | Medium | For non-Ollama environments |
| Consolidation daemon | Medium | Periodic R refresh |
| CLI commands | Low | doctor/stats/consolidate |

### Future (v2+)

| Feature | Notes |
|---------|-------|
| Judge agent for conflicts | Async resolution with LLM |
| Qwen distillation | trace -> skill extraction |
| Cross-device sync | Managed service feature |
| Anomaly detection | Flag contradictions on ingest |
| Full cat animation | Beyond 6 states |

---

## Integration Points

### With Engrammic

The existing `packages/engrammic/` handles context window management. Veil-memory provides persistent storage:

```
engrammic (context window)
    |
    +-- warm cache (in-memory)
    |
    +-- veil-memory (persistent)
            |
            +-- event log (append-only)
            +-- projection (current beliefs)
            +-- vectors (sqlite-vec)
```

Key integration: engrammic's `kgPointer` field links to veil-memory event IDs.

### With Agent Harnesses

Via MCP tools:
- `memory_recall` — semantic search, tier-aware
- `memory_learn` — factual with supersession
- `memory_remember` — episodic (no supersession)
- `memory_skill` — procedural
- `memory_forget` — explicit retraction
- `memory_history` — belief evolution
- `memory_conflicts` — unresolved conflicts
- `memory_resolve` — manual resolution

---

## Test Results

```
 ✓ test/fsrs.test.ts (16 tests)
   - computeRetrievability: 5 tests
   - updateStability: 4 tests
   - updateDifficulty: 3 tests
   - getTier: 3 tests
   - getInitialStability: 1 test

 ✓ test/version-vector.test.ts (17 tests)
   - dominates: 5 tests
   - merge: 2 tests
   - increment: 3 tests
   - areConcurrent: 2 tests
   - isEmpty: 2 tests
   - compare: 3 tests

 33 tests passing
```

---

## Files Changed

```
packages/veil-memory/           # NEW PACKAGE
docs/VEIL-MEMORY-SPEC.md        # Reference spec (unchanged)
docs/VEIL-MEMORY-CHECKPOINT.md  # This file
```

---

## Next Steps

1. [ ] Create MCP server (`src/mcp/server.ts`, `src/mcp/tools.ts`)
2. [ ] Add transformers.js fallback embedder
3. [ ] Wire engrammic's cold storage to veil-memory
4. [ ] Add consolidation sweep (cron or on-demand)
5. [ ] Test with actual agent session

---

## Dependencies

```json
{
  "better-sqlite3": "^11.9.1",
  "sqlite-vec": "^0.1.9",
  "ulid": "^2.3.0"
}
```

Optional peer:
- `@huggingface/transformers` — for fallback embedding without Ollama

---

*Checkpoint created: 2026-06-18 01:51 UTC*
