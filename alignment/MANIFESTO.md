# Manifesto

## Context is understanding, not just history

A conversation transcript is not context. Context is what the agent *understands* — the decisions made, the constraints discovered, the patterns learned, the mistakes corrected.

Current systems treat context as a log to be compressed. Veil treats it as understanding to be preserved.

## Forgetting is load-bearing

A system that never forgets cannot prioritize. A system that cannot prioritize cannot reason well under resource constraints.

The research is unambiguous: total recall is counterproductive. Unbounded memory causes retrieval noise (irrelevant context surfaces), hallucination amplification (stale facts reinforce wrong beliefs), and context dilution (useful signal drowns in accumulated noise).

Forgetting isn't a bug. It's how memory works.

The question isn't "how do we remember everything?" It's "how do we remember what matters?"

## Against the context window arms race

The industry response to context limits has been to make context windows bigger. 8K became 32K became 128K became 200K became 1M.

This is a treadmill, not a solution.

Bigger windows don't solve the coherence problem — they delay it. An agent with a 1M context window still hits the same reliability cliff, just later. And the economics don't scale: inference cost grows with context length, latency increases, and the model's attention becomes more diffuse.

The answer isn't more capacity. It's better curation.

## Memory should be active, not passive

Passive memory accumulates everything and hopes retrieval will sort it out. Active memory decides what to keep, what to surface, and what to let fade — in real time, based on what's happening now.

Veil's cognitive weight system makes memory active:
- Tool success reinforces retention
- Tool failure accelerates decay  
- Task relevance determines what surfaces
- Time matters, but isn't everything

Memory that responds to outcomes, not just access patterns.

## Explicit over magic

Veil integrates through hooks, not hidden behavior.

```typescript
beforeToolCall()  // Check eviction, manage budget
afterToolCall()   // Update cognitive weight based on outcome
```

The harness is passed in, not created. The caller owns lifecycle. Events are emitted for observation. Nothing happens that you can't see.

Magic creates debugging nightmares. Explicit creates understanding.

## Ship simple, expand later

Single-agent memory before multi-agent orchestration.

The temptation is to solve the whole problem — distributed memory, cross-agent context sharing, conflict resolution, consensus. But the single-agent case isn't solved yet.

Veil ships the single-agent tier first. Multi-agent is specced and waiting. The foundation has to work before the superstructure.

## The cognitive reframe

Memory management in AI agents has been treated as a systems problem: caches, eviction policies, storage tiers.

It's actually a cognitive problem: what does it mean to remember? What should be retained? How does context become understanding?

Veil doesn't just manage context. It implements a theory of what context management should be.

---

*"Retained memory should maximize cumulative relevance under a budget constraint, not maximize total information."*
— arXiv 2602.06052
