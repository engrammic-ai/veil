# Roadmap

Prototype phases for the Engrammic harness.

---

## Phase 1: Core Scaffold (Week 1)

**Goal**: Minimal harness with warm cache and pointer syntax.

### Tasks

- [ ] Fork Pi Agents (MIT licensed)
- [ ] Add SQLite warm cache with schema from eviction-strategy.md
- [ ] Implement pointer stub syntax: `[FILE:...]`, `[EPISODE:...]`, `[FACT:...]`
- [ ] Add hydration function for stubs
- [ ] Wire pre-tool-call hook for context refresh trigger

### Success Criteria

- Agent can reference `[FILE:path:lines]` and harness hydrates on demand
- Warm cache persists across turns
- Hook fires before each tool call

---

## Phase 2: Eviction Loop (Week 2)

**Goal**: Heuristic-based eviction without LLM calls.

### Tasks

- [ ] Implement eviction_score() function
- [ ] Add 4-stage eviction cascade (hard → soft → demote → rot)
- [ ] Add `procedural` vs `episodic` tagging
  - Heuristic: code/config = procedural, conversation/exploration = episodic
- [ ] Implement checkpoint turns with agent self-triage prompt
- [ ] Add cognitive weight tracking (+/- on tool success/failure)

### Success Criteria

- Context stays under 70% token limit automatically
- Procedural items survive longer than episodic
- Agent can see and respond to checkpoint prompts

---

## Phase 3: KG Integration (Week 3)

**Goal**: Connect Engrammic KG as cold storage backend.

### Tasks

- [ ] Implement bi-temporal writes
  - `valid_time` from git commit timestamp (when applicable)
  - `system_time` from ingestion time
- [ ] Add episode boundary detection using embedding discontinuity
  - Use local model: `all-MiniLM-L6-v2` (80MB)
  - Threshold: cosine < 0.7 = new episode
- [ ] Implement demote_to_cold() with KG node creation
- [ ] Add tombstone support (keep ID, drop content, preserve refs)
- [ ] Wire `[FACT:...]` stubs to KG retrieval

### Success Criteria

- Episodes auto-close and summarize on boundary detection
- Cold storage nodes have valid_time + system_time
- Tombstoned items still retrievable by ID (show "evicted" state)

---

## Phase 4: Validation (Week 4)

**Goal**: Tune and validate on real coding sessions.

### Tasks

- [ ] Run against 5+ real coding sessions (varied: debugging, feature, refactor)
- [ ] Log all eviction decisions with reasoning
- [ ] Track "user re-requested evicted content" events
- [ ] Tune parameters:
  - Recency half-life (default: 30min)
  - Eviction score threshold (default: 0.3)
  - Checkpoint interval (default: 10 turns)
  - Rot decay factor (default: 0.95/week)
- [ ] Add decay calibration: auto-adjust based on re-request rate

### Success Criteria

- <5% re-request rate for evicted content
- Context churn measured and documented
- Parameter recommendations for different workloads

---

## Future Phases

### Phase 5: Anticipatory Loading
- Keyword → action rules learned from past sessions
- "user said 'test' → preload test files"
- No LLM for prediction, just pattern matching

### Phase 6: Cross-Session Episodes
- Episode chains via KG edges: "relates to yesterday's refactor"
- "remind me what I tried last time" queries

### Phase 7: AST-Aware Compression
- Function → `{signature} + [IMPL:hash]`
- Class → `{declaration} + [METHODS:hash]`
- Hydrate full impl only when referenced

### Phase 8: Confidence-Aware Retrieval
- Track confidence on KG facts
- Surface uncertainty: "I'm 40% sure X, want me to verify?"

---

## Key Insight

> Start with eviction, not KG integration. Most harnesses fail by loading too much, not by retrieving poorly.

Phases 1-2 are the critical path. Get eviction right first.
