# Principles

Design decisions and constraints that guide Veil's implementation.

---

## Three tiers, no more

```
Hot (Map) → Warm (SQLite) → Cold (Adapters)
```

**Hot**: In-memory Map. What's actively loaded in the context window. Fast, bounded, ephemeral.

**Warm**: SQLite cache. Recent context with metadata (access count, decay score, cognitive weight). Local, queryable, session-persistent.

**Cold**: Pluggable adapters (SQLite, Zep, LanceDB, Chroma, MCP). Long-term storage that survives sessions. Searchable, durable.

Why three? Two isn't enough granularity — you need a middle tier for "recent but not active." Four adds complexity without benefit. Three maps to how humans actually think about memory: working, short-term, long-term.

---

## Cognitive weight over recency

Eviction scoring combines multiple signals:

| Signal | What it measures |
|--------|-----------------|
| Recency | Time since last access |
| Frequency | How often accessed (spacing effect) |
| Decay | Exponential time-based fade |
| Cognitive weight | Did it help? +weight on success, -weight on failure |
| Pinning | Explicit "never evict this" |

Pure recency eviction (LRU) is naive — it keeps whatever was touched last, regardless of usefulness. Cognitive weight means context that *helped the agent succeed* stays longer than context that didn't.

The formula: relevance = f(recency, frequency, decay, cognitive_weight, task_distance)

---

## Hooks over middleware

Veil integrates through explicit callbacks:

```typescript
beforeToolCall(context, signal)  // Eviction check, budget management
afterToolCall(context, signal)   // Cognitive weight update
```

Not:
- Middleware that wraps every call invisibly
- Decorators that modify behavior implicitly
- Event buses with unclear delivery semantics

Hooks are:
- Explicit integration points
- Debuggable (you can log what happened)
- Optional (no harness = no hooks = no behavior change)

---

## Caller owns lifecycle

```typescript
const harness = new VeilHarness({ dbPath: '.veil/context.db' });
const session = new AgentSession({ veilHarness: harness });
// ... use session ...
await harness.close();
```

The harness is passed in, not created internally. AgentSession uses it but doesn't own it. Disposal is the caller's responsibility.

Why? 
- Testability: mock the harness, test the session
- Flexibility: share a harness across sessions, or don't
- Clarity: no hidden state, no lifecycle surprises

---

## Independence from compaction

Veil and compaction are separate systems that don't coordinate (for now).

Compaction summarizes the context window when it gets too large. Veil manages what's *in* the context window before compaction happens. They can both run. They don't fight.

Future: Veil eviction runs *before* compaction, reducing context size so compaction triggers less often. But that's optimization, not v1.

---

## Events for observation

Core behavior uses callbacks. Extension integration uses events.

```typescript
// Callbacks (internal)
onEviction: (evicted) => { /* bookkeeping */ }
onCheckpoint: (turn) => { /* persistence */ }

// Events (external)
extensionRunner.emit({ type: 'context_eviction', evicted })
```

Extensions can observe without affecting core behavior. Core behavior doesn't depend on extension presence.

---

## Memory types follow cognitive science

| Type | What it stores | Example |
|------|---------------|---------|
| Episodic | Instance-specific experiences | "User said don't mock the DB" |
| Procedural | Skills and patterns | "This repo uses vitest, not jest" |
| Fact | Abstracted knowledge | "The API endpoint is /v2/users" |

This taxonomy (CoALA, 2024) has become the industry standard. Veil adopts it rather than inventing something new.

---

## Budget-constrained optimization

> "Retained memory should maximize cumulative relevance under a budget constraint, not maximize total information."

The goal isn't to remember everything. It's to remember what maximizes usefulness given finite capacity.

This reframes eviction from "what can we drop" to "what improves retrieval fidelity by being dropped."

---

## Gradual decay over hard deletion

Research shows abrupt deletion harms multi-hop reasoning. Items don't disappear — they fade:

1. Access count decays over time
2. Cognitive weight adjusts based on outcomes
3. Items below threshold move from hot → warm
4. Items in warm eventually move to cold
5. Only explicit `forget()` fully removes

Graceful degradation, not cliff edges.

---

## Single-agent first

Multi-agent orchestration is specced (`context/go-orchestrator-spec.md`) but parked.

Ship what works for one agent. Validate the tier model. Then extend to many.

Premature multi-agent support adds:
- Distributed state coordination
- Context conflict resolution  
- Cross-agent relevance scoring
- Consensus on eviction

None of that matters if single-agent doesn't work. Foundation first.
