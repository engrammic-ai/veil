# Eviction Strategy

Heuristic-based context eviction with no LLM calls for memory operations.

---

## Design Principles

1. **Agent owns behavior** - harness triggers, agent decides
2. **No LLM for memory ops** - all heuristics computable from metadata
3. **Transform, don't delete** - chunk → summary → pointer → tombstone
4. **Preserve causal chains** - never evict items with living dependents

---

## Warm Cache Schema (SQLite)

```sql
CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    
    -- Access tracking
    created_at REAL NOT NULL,
    last_access REAL NOT NULL,
    access_count INTEGER DEFAULT 1,
    
    -- Scoring
    decay_score REAL DEFAULT 1.0,
    cognitive_weight REAL DEFAULT 0.0,  -- -1 to +1, success/failure attribution
    
    -- Classification
    chunk_type TEXT CHECK(chunk_type IN ('episodic', 'procedural')),
    tags TEXT,  -- JSON array
    
    -- KG linkage
    kg_pointer TEXT,  -- node ID in cold storage
    depends_on TEXT,  -- JSON array of chunk IDs
    
    -- Bi-temporal
    valid_from REAL,  -- when true in world (e.g., git commit time)
    valid_until REAL  -- NULL if still valid
);

CREATE INDEX idx_last_access ON chunks(last_access);
CREATE INDEX idx_decay_score ON chunks(decay_score);
CREATE INDEX idx_chunk_type ON chunks(chunk_type);
```

---

## Scoring Function

```python
def eviction_score(chunk, current_task_tokens):
    """
    Higher score = more valuable = keep longer.
    All inputs are metadata, no LLM calls.
    """
    # Time decay with 30-minute half-life
    age_minutes = (now() - chunk.last_access) / 60
    recency = 0.5 ** (age_minutes / 30)
    
    # Log frequency (diminishing returns)
    frequency = log(chunk.access_count + 1) / log(10)  # normalize to ~0-1
    
    # Token overlap with current task
    relevance = jaccard(chunk.tokens, current_task_tokens)
    
    # Structural importance (has KG refs = load-bearing)
    structural = 1.0 if chunk.kg_pointer else 0.5
    
    # Type modifier (procedural decays slower)
    type_mod = 1.2 if chunk.chunk_type == 'procedural' else 1.0
    
    # Cognitive weight from past success/failure
    cog_boost = (chunk.cognitive_weight + 1) / 2  # map -1..+1 to 0..1
    
    base = (0.25 * recency + 
            0.15 * frequency + 
            0.30 * relevance + 
            0.15 * structural +
            0.15 * cog_boost)
    
    return base * type_mod
```

---

## Eviction Cascade

### Layer 1: Heuristics (every turn)

Check on every tool call via pre-hook:

```python
def pre_tool_hook():
    token_usage = estimate_context_tokens()
    
    if token_usage > 0.7 * MAX_TOKENS:
        trigger_eviction_pass()
```

### Layer 2: Eviction Pass

```python
def trigger_eviction_pass():
    chunks = get_all_warm_chunks()
    current_task = get_current_task_tokens()
    
    for chunk in chunks:
        score = eviction_score(chunk, current_task)
        
        # Stage 1: Hard evict stale single-access items
        if chunk.age > 2_HOURS and chunk.access_count == 1:
            hard_evict(chunk)
            continue
        
        # Stage 2: Soft evict low-score items
        if score < 0.3:
            if len(chunk.content) > 500:
                summary = summarize_to_warm(chunk)  # agent does this
            demote_to_cold(chunk)
            continue
        
        # Stage 3: Flag for agent review
        if score < 0.5:
            flag_for_review(chunk)
```

### Layer 3: Agent Self-Triage

At checkpoint turns (configurable, default every 10 turns):

```
System: Context checkpoint. Currently loaded:
- [episodic] debugging auth flow (score: 0.4, 1.2k tokens)
- [procedural] test conventions (score: 0.8, 300 tokens)
- [episodic] explored user model (score: 0.35, 800 tokens)

What do you still need? Reply with IDs to keep, or "compress <id>" to summarize.
```

Agent responds, harness acts.

---

## Rot Prevention (Background)

Weekly sweep on cold storage:

```python
def rot_sweep():
    for node in kg.all_nodes():
        if node.last_access > 7_DAYS:
            node.confidence *= 0.95
        
        if node.confidence < 0.1:
            tombstone(node)  # keep ID, drop content
```

---

## Pointer Stubs

Active context holds stubs, not content:

```
[FILE:src/auth.ts:45-80]
[EPISODE:debugging-auth-2026-06-13]
[FACT:user-model-has-email-field:kg_node_123]
```

Hydration on reference:

```python
def hydrate(stub):
    if stub.startswith('[FILE:'):
        path, lines = parse_file_stub(stub)
        return read_file_lines(path, lines)
    elif stub.startswith('[EPISODE:'):
        episode_id = parse_episode_stub(stub)
        return warm_cache.get(episode_id).content
    elif stub.startswith('[FACT:'):
        node_id = parse_fact_stub(stub)
        return kg.get_node(node_id).to_context()
```

---

## Cognitive Weight Updates

After each tool call, update chunk weights:

```python
def post_tool_hook(tool_result, chunks_in_context):
    success = tool_result.success
    delta = 0.1 if success else -0.1
    
    for chunk in chunks_in_context:
        # Decay toward neutral over time
        chunk.cognitive_weight *= 0.95
        # Apply success/failure signal
        chunk.cognitive_weight += delta
        chunk.cognitive_weight = clamp(chunk.cognitive_weight, -1, 1)
```

---

## Episode Boundary Detection

New episode when embedding discontinuity detected:

```python
def check_episode_boundary(prev_chunk, curr_chunk):
    similarity = cosine(embed(prev_chunk), embed(curr_chunk))
    
    if similarity < 0.7:
        # Start new episode
        close_episode(current_episode)
        current_episode = new_episode()
        
        # Summarize closed episode to warm cache
        summary = agent_summarize(closed_episode)
        warm_cache.add(summary, type='episodic')
```

Uses local embedding model (e.g., `all-MiniLM-L6-v2`, 80MB) - no cloud calls.

---

## Conversation Eviction

Separate from memory chunk eviction, conversation eviction prunes old conversation turns while preserving critical context (decisions, corrections, intent declarations).

Key differences from memory eviction:
- **Scope**: Conversation turns vs memory chunks
- **Storage**: `conversation_archive` table vs warm/cold memory tiers
- **Classification**: Turn types (decision, exploration, action) vs chunk types (episodic, procedural)
- **Reference tracking**: Embedding similarity for implicit references vs explicit dependency graphs

See [SPEC-intent-tracking.md](SPEC-intent-tracking.md#conversation-eviction) for full details.

Components:
- `turn-classifier.ts` - Classify turns via `<turn-meta>` or heuristics
- `turn-eviction.ts` - Score turns for eviction (12-turn protected window)
- `reference-detector.ts` - Embedding similarity for reference detection
- `turn-stub.ts` - Generate stubs for evicted turns
- `eviction-feedback.ts` - Learn from eviction mistakes
