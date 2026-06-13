# Vision

## The Problem

AI coding agents lose context as conversations grow.

Context windows are finite. Conversations aren't. When an agent hits its limit, current solutions either **truncate** (lose everything) or **compact** (summarize and lose detail). Both fail the same way: the agent forgets decisions made 30 minutes ago, repeats mistakes it was corrected on, loses the thread of complex work.

This isn't a edge case. Research shows 65% of enterprise AI failures stem from context drift or memory loss — not token exhaustion. Agents fail silently, producing plausible output while operating on degraded understanding.

The reliability cliff is predictable: agents that work well at 30 minutes become unreliable at 90 minutes as compaction degrades coherence.

## The Insight

Human memory doesn't dump. It tiers, decays, and recalls on relevance.

We don't summarize our experiences into a compressed blob when we run out of attention. We push things to the back of our mind, surface them when relevant, and let unimportant details fade naturally. The important things stick — not because they're recent, but because they mattered.

What if context management was *cognitive*, not mechanical?

## The Destination

Agents that remember what matters and forget what doesn't.

Veil implements tiered context with relevance-aware eviction:

```
Hot (active work) → Warm (recent, retrievable) → Cold (persistent, searchable)
```

- **Hot**: In-context working memory. What the agent is actively using.
- **Warm**: SQLite cache. Recent context that can be loaded on demand.
- **Cold**: Persistent storage. Searchable archive that survives sessions.

Eviction isn't by age alone. It's by *cognitive weight* — success reinforces retention, failure accelerates decay. Context that helped the agent stays; context that didn't, fades.

## The Gap We Fill

The market has memory systems. The market has agent frameworks. No one has shipped an **agent harness with cognitive context management built in**.

### Memory Systems

| System | What it does | What it misses |
|--------|--------------|----------------|
| Mem0 | Extracts facts to vector+graph | 49% temporal accuracy, flattens time |
| Zep/Graphiti | Temporal knowledge graph | Heavy infrastructure, write latency |
| Letta (MemGPT) | Self-editing memory | Model-dependent, fragile |
| Hindsight | Video-based context replay | Specialized use case, not general memory |
| Compaction | Summarizes old context | Lossy, ephemeral, flattens nuance |
| RAG | Retrieves code artifacts | Doesn't store agent reasoning or decisions |

Everyone evicts on access patterns. No one evicts on usefulness to the current task.

### Where Veil Sits

Veil is not a memory system. It's an **agent harness** — the layer between your agent loop and your tools.

Memory systems answer: "How do I store and retrieve facts?"
Veil answers: "How does the agent decide what to keep in context, moment to moment?"

The combination of harness hooks + tiered storage + relevance-aware eviction, in a coding-agent context where "current file" vs "project background" vs "past decisions" maps cleanly to hot/warm/cold, is unoccupied territory.

### Open Source

Veil is open source. The agent orchestration layer shouldn't be proprietary infrastructure you depend on — it should be something you can inspect, modify, and own.

Memory is too important to be a black box.

## Success Looks Like

An agent that can work on a codebase for hours without forgetting early decisions.

An agent that remembers it was told "don't mock the database in these tests" three sessions ago.

An agent that surfaces relevant past context when you return to a file you haven't touched in weeks.

An agent where memory is a feature, not a bug to work around.

---

*Research grounding: arXiv 2502.06975 (episodic memory), arXiv 2603.11768 (SSGM), arXiv 2604.02280 (adaptive decay), ICLR 2026 MemAgents Workshop, Qodo State of AI Code Quality 2025.*
