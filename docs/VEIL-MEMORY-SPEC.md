# Veil Memory Companion Specification

> A local-first, FSRS-powered memory system for AI agents.  
> Codename: "The Cat"

---

## Overview

Veil Memory is a **companion system** that adds persistent, decaying memory to any AI agent harness. It can run as:

1. **Managed service** (primary) — zero setup, MCP endpoint, we handle infra
2. **Local stack** (opt-in) — SQLite + Ollama, fully offline, privacy-first

Same MCP interface for both. Agents don't know which backend they're using.

---

## Design Principles

- **Local-first**: SQLite + local embeddings, no cloud dependency required
- **Compressed**: Store patterns, not transcripts
- **Decaying**: FSRS-based forgetting — access reinforces, disuse fades
- **Bi-temporal**: Track both "when true in world" and "when we learned it"
- **Event-sourced**: Append-only writes, derived state via projection
- **Conflict-aware**: Version vectors detect concurrent edits, preserve for resolution
- **Visual**: ASCII cat shows state, inline annotations show value

---

## Visual UX: The Cat

Minimal ASCII cat in terminal/IDE showing companion state.

### Standard Mode (Unicode)

```
   /\_/\     sleeping (idle)
  ( o.o )    
   > ^ <

   /\_/\     remembering...
  ( ◕.◕ )    
   > ~ <

   /\_/\     recalled something!
  ( ^.^ )    
   > ♦ <
```

### ASCII Fallback (Windows cmd / SSH)

```
   /\_/\     sleeping
  ( o.o )    
   > ^ <

   /\_/\     remembering...
  ( o.o )    
   > ~ <

   /\_/\     recalled!
  ( ^.^ )    
   > * <
```

### Configuration

```typescript
interface CatConfig {
  enabled: boolean;           // default: true
  position: 'statusbar' | 'inline' | 'off';
  mode: 'unicode' | 'ascii' | 'auto';  // auto detects terminal
  minimal: boolean;           // one-liner mode: "memory: 3 recalled, 1 learned"
}
```

### States

| State | Trigger | Duration |
|-------|---------|----------|
| `sleeping` | No activity | Indefinite |
| `watching` | Turn started | Until turn ends |
| `remembering` | Query in progress | Until results |
| `learned` | New memory stored | 2 seconds |
| `recalled` | Memory injected | 2 seconds |
| `conflict` | Concurrent writes detected | Until resolved |

### Inline Annotations

```
[recalled: auth pattern from June 3]
[learned: API uses OAuth2 with PKCE — supersedes previous belief]
[reinforced: deploy procedure — stability 8.2d → 12.1d]
[conflict: 2 agents disagree on rate limit — pending resolution]
```

### Session Summary

```
   /\_/\     SESSION END
  ( ^.^ )    remembered: 4 | learned: 2 | recalled: 7
   > ~ <     stability avg: 6.3 days | conflicts: 1 | evicted: 3
```

---

## Memory Taxonomy

| Type | What it is | Supersession | Decay Rate | Example |
|------|-----------|--------------|------------|---------|
| **Episodic** | "I saw X at time T" | Never — history is immutable | Fast | "Debugged OAuth on Tuesday" |
| **Factual** | "X is true" | Yes — facts change | Slow | "API uses OAuth2 with PKCE" |
| **Procedural** | "How to do X" | Yes — methods evolve | Slowest | "To deploy: run npm build, then..." |

**Key distinction:** Facts have subjects (can be superseded); episodes are just historical (fade naturally).

---

## Storage Architecture

### Layered Design

```
┌─────────────────────────────────────┐
│  Layer 1: Event Log                 │  ← Source of truth (append-only)
│  - INSERT only, no UPDATE/DELETE   │
│  - SQLite WAL for crash recovery    │
│  - Version vectors per event        │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  Layer 2: Conflict Detection        │  ← Version vector comparison
│  - Causal ordering                  │
│  - Concurrent writes → siblings     │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  Layer 3: Projection                │  ← Derived state (rebuildable)
│  - Current beliefs view             │
│  - Conflicts view                   │
│  - FSRS decay applied here          │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  Layer 4: Vector Search             │  ← sqlite-vec
│  - Semantic similarity              │
│  - FSRS-weighted ranking            │
└─────────────────────────────────────┘
```

### Stack

```
┌─────────────────────────────────────┐
│  SQLite + Extensions                │
│  - sqlite-vec (vector search)       │
│  - (optional) cr-sqlite (CRDTs)     │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Embedding                          │
│  Primary: Ollama + nomic-embed-text │
│  Fallback: transformers.js          │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Local Distillation (optional)      │
│  - Qwen2.5 3B (Q4_K_M)              │
│  - For trace → skill extraction     │
└─────────────────────────────────────┘
```

---

## Event-Sourced Schema

### Event Log (Source of Truth)

```sql
-- Events table: append-only, never updated
CREATE TABLE memory_events (
  event_id TEXT PRIMARY KEY,              -- ULID (time-sortable)
  namespace TEXT NOT NULL,
  
  -- Event metadata
  event_type TEXT NOT NULL CHECK(event_type IN ('assert', 'retract', 'reinforce')),
  agent_id TEXT NOT NULL,
  
  -- Content
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  
  -- Classification
  memory_type TEXT NOT NULL CHECK(memory_type IN ('episodic', 'factual', 'procedural')),
  subject TEXT,                           -- factual/procedural only
  subject_hash TEXT,
  
  -- Version vector (JSON: {"agent_a": 3, "agent_b": 1})
  version_vector TEXT NOT NULL,
  
  -- Confidence (factual only)
  confidence REAL DEFAULT 0.8 CHECK(confidence BETWEEN 0 AND 1),
  evidence_count INTEGER DEFAULT 1,
  
  -- Bi-temporal
  valid_from REAL NOT NULL,               -- when true in world
  recorded_at REAL NOT NULL,              -- when we learned it
  
  -- FSRS initial values
  difficulty REAL DEFAULT 0.5 CHECK(difficulty BETWEEN 0.1 AND 0.9),
  stability REAL DEFAULT 1.0 CHECK(stability >= 0.001),
  
  -- Embedding model version (for re-embedding on upgrade)
  embedding_model TEXT DEFAULT 'nomic-embed-text-v1.5',
  
  -- Source provenance
  source_tier TEXT CHECK(source_tier IN (
    'authoritative',  -- Official docs, .gov, .edu
    'validated',      -- Curated data, verified sources
    'observed',       -- Agent observations, tool outputs
    'inferred'        -- Synthesized from other memories
  )) DEFAULT 'observed',
  
  -- Tags (JSON array)
  tags TEXT DEFAULT '[]'
);

-- Indexes
CREATE INDEX idx_events_namespace ON memory_events(namespace);
CREATE INDEX idx_events_subject ON memory_events(subject_hash) 
  WHERE memory_type IN ('factual', 'procedural');
CREATE INDEX idx_events_recorded ON memory_events(recorded_at);
CREATE INDEX idx_events_type ON memory_events(memory_type);
CREATE INDEX idx_events_content_hash ON memory_events(content_hash);
CREATE INDEX idx_events_valid_from ON memory_events(valid_from);

-- Vector embeddings (sqlite-vec uses rowid internally, join on event_id separately)
CREATE VIRTUAL TABLE memory_vectors USING vec0(
  embedding FLOAT[768]
);

-- Link vectors to events
CREATE TABLE memory_vector_map (
  rowid INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (event_id) REFERENCES memory_events(event_id)
);

-- Schema version for migrations
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at REAL NOT NULL
);
INSERT INTO schema_version VALUES (1, strftime('%s', 'now') * 1000);
```

### Current State Projection

```sql
-- Materialized view: current beliefs (latest per subject, no conflicts)
CREATE TABLE current_beliefs (
  event_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  subject TEXT,
  subject_hash TEXT,
  confidence REAL,
  valid_from REAL NOT NULL,
  recorded_at REAL NOT NULL,
  
  -- FSRS live values (updated on access)
  difficulty REAL NOT NULL,
  stability REAL NOT NULL,
  retrievability REAL NOT NULL,
  last_recall REAL,
  recall_count INTEGER DEFAULT 0,
  
  -- Conflict tracking
  has_conflicts INTEGER DEFAULT 0,
  conflict_event_ids TEXT,  -- JSON array of conflicting event IDs
  
  FOREIGN KEY (event_id) REFERENCES memory_events(event_id)
);

CREATE INDEX idx_beliefs_namespace ON current_beliefs(namespace);
CREATE INDEX idx_beliefs_subject ON current_beliefs(subject_hash);
CREATE INDEX idx_beliefs_retrievability ON current_beliefs(retrievability);

-- View: unresolved conflicts
CREATE VIEW belief_conflicts AS
SELECT 
  e1.subject_hash,
  e1.event_id as event_id_a,
  e2.event_id as event_id_b,
  e1.content as content_a,
  e2.content as content_b,
  e1.agent_id as agent_a,
  e2.agent_id as agent_b,
  e1.confidence as confidence_a,
  e2.confidence as confidence_b,
  e1.recorded_at as recorded_at_a,
  e2.recorded_at as recorded_at_b
FROM memory_events e1
JOIN memory_events e2 ON e1.subject_hash = e2.subject_hash
WHERE e1.namespace = e2.namespace
  AND e1.event_id < e2.event_id
  AND e1.memory_type IN ('factual', 'procedural')
  AND e2.memory_type IN ('factual', 'procedural')
  -- Neither version vector dominates (concurrent)
  AND NOT EXISTS (
    SELECT 1 FROM current_beliefs 
    WHERE event_id = e1.event_id OR event_id = e2.event_id
  );
```

---

## Version Vectors

### Purpose

Version vectors enable **causal ordering** without wall-clock timestamps:
- If V1 dominates V2 → V1 causally follows V2 (supersession)
- If neither dominates → concurrent writes (conflict, keep both)

### Implementation

```typescript
type VersionVector = Record<string, number>;  // { "agent_a": 3, "agent_b": 1 }

// Check if v1 causally dominates v2
function dominates(v1: VersionVector, v2: VersionVector): boolean {
  let dominated = true;
  let strict = false;
  
  const allKeys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  
  for (const key of allKeys) {
    const val1 = v1[key] ?? 0;
    const val2 = v2[key] ?? 0;
    
    if (val1 < val2) dominated = false;
    if (val1 > val2) strict = true;
  }
  
  return dominated && strict;
}

// Merge two version vectors (take max of each)
function merge(v1: VersionVector, v2: VersionVector): VersionVector {
  const result: VersionVector = { ...v1 };
  for (const [key, val] of Object.entries(v2)) {
    result[key] = Math.max(result[key] ?? 0, val);
  }
  return result;
}

// Increment agent's counter
function increment(v: VersionVector, agentId: string): VersionVector {
  return { ...v, [agentId]: (v[agentId] ?? 0) + 1 };
}
```

### Write Flow

```
Agent A wants to learn a fact about subject X
         │
         ▼
┌────────────────────────────────────────┐
│ 1. Read current version vector for X   │
│    (from latest event for subject_hash)│
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ 2. Increment own counter               │
│    vv_new = increment(vv_current, "A") │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ 3. Append event with vv_new            │
│    (always succeeds - append-only)     │
└────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ 4. Update projection                   │
│    - If dominates old → supersede      │
│    - If concurrent → mark conflict     │
└────────────────────────────────────────┘
```

---

## FSRS Decay Model

Inspired by Free Spaced Repetition Scheduler, adapted for agent memory. Uses a power-law forgetting curve calibrated so R=0.9 when t=S.

### Core Formula

```
R(t) = (1 + FACTOR × t/S)^DECAY

where:
  R = retrievability (0-1, probability of recall)
  t = days since last recall
  S = stability (days until R drops to 90%)
  FACTOR = 19/81 ≈ 0.2346
  DECAY = -0.5
```

When `t = S`: `R = (1 + 19/81)^(-0.5) = (100/81)^(-0.5) = 0.9` exactly.

### Constants

```typescript
const FSRS = {
  // Retrievability decay (calibrated so R=0.9 at t=S)
  FACTOR: 19 / 81,  // ≈ 0.2346
  DECAY: -0.5,
  
  // Stability update parameters (tuned conservatively)
  // sInc = 1 + GROWTH * (11 - D*10)^DIFF_WEIGHT * S^(-S_WEIGHT) * (e^((1-R)*R_WEIGHT) - 1)
  GROWTH: 1.0,        // base growth rate (FSRS-5 uses ~0.5-2.5)
  DIFF_WEIGHT: 0.5,   // difficulty influence
  S_WEIGHT: 0.2,      // diminishing returns on high S
  R_WEIGHT: 1.5,      // surprise boost (low R recall = stronger memory)
  
  // Stability bounds
  MIN_STABILITY: 0.001,   // prevent division by zero
  MAX_STABILITY: 365,     // cap at 1 year
  
  // Difficulty bounds
  MIN_DIFFICULTY: 0.1,
  MAX_DIFFICULTY: 0.9,
  INITIAL_DIFFICULTY: 0.5,  // cold-start at middle
  
  // Type-specific initial stability
  INITIAL_STABILITY: {
    episodic: 0.5,    // 0.5 days (fast decay)
    factual: 1,       // 1 day
    procedural: 7     // 7 days (skills are expensive)
  },
  
  // Type-specific caps
  STABILITY_CAP: {
    episodic: 30,     // 30 days max
    factual: 365,     // 1 year
    procedural: 365   // 1 year
  },
  
  // Retrievability tiers (for context placement)
  TIER_HOT: 0.7,      // R > 0.7 → inject at edges
  TIER_WARM: 0.3,     // 0.3 < R ≤ 0.7 → inject on demand
  // R ≤ 0.3 → cold (stubs only)
  
  // Consolidation
  CONSOLIDATION_INTERVAL_MS: 30 * 60 * 1000,  // 30 minutes
  EVICTION_THRESHOLD: 0.01,                    // R < 0.01 → archive
  PRUNE_KEEP_PER_SUBJECT: 10                   // keep last N versions
};
```

### Update Rules

```typescript
function computeRetrievability(stability: number, daysSinceRecall: number): number {
  // Clamp negative intervals (clock skew protection)
  if (daysSinceRecall <= 0) return 1.0;
  
  const s = Math.max(FSRS.MIN_STABILITY, stability);
  // R = (1 + FACTOR * t/S)^DECAY where DECAY is negative
  return Math.pow(1 + FSRS.FACTOR * (daysSinceRecall / s), FSRS.DECAY);
}

function updateStability(
  oldStability: number,
  difficulty: number,
  retrievability: number,
  memoryType: MemoryType
): number {
  // Stability increase formula (all constants configurable)
  // Key insight: surprising recalls (low R) strengthen memory more
  const sInc = 1 + FSRS.GROWTH * 
               Math.pow(11 - difficulty * 10, FSRS.DIFF_WEIGHT) * 
               Math.pow(Math.max(oldStability, FSRS.MIN_STABILITY), -FSRS.S_WEIGHT) * 
               (Math.exp((1 - retrievability) * FSRS.R_WEIGHT) - 1);
  
  // Example: D=0.5, R=0.5, S=1 → sInc ≈ 1.8 → S: 1 → 1.8 days (not 91!)
  const newS = oldStability * sInc;
  return Math.min(FSRS.STABILITY_CAP[memoryType], Math.max(FSRS.MIN_STABILITY, newS));
}

function updateDifficulty(oldDifficulty: number, wasHard: boolean): number {
  const target = wasHard ? 0.7 : 0.3;
  const newD = oldDifficulty + 0.1 * (target - oldDifficulty);
  return Math.max(FSRS.MIN_DIFFICULTY, Math.min(FSRS.MAX_DIFFICULTY, newD));
}
```

### Edge Case Handling

| Edge Case | Problem | Solution |
|-----------|---------|----------|
| Clock skew | Negative `daysSinceRecall` → NaN | Clamp to 0 |
| Zero stability | Division by zero | MIN_STABILITY = 0.001 |
| Stability explosion | Unbounded growth | Type-specific caps |
| Monotonic time | System clock jumps | Use monotonic counter for ordering |

---

## Retrievability Tiers

Map FSRS retrievability to hot/warm/cold tiers for context injection strategy.

### Tier Definitions

| Tier | Retrievability | Behavior |
|------|----------------|----------|
| **Hot** | R > 0.7 | Inject at context edges (start/end) |
| **Warm** | 0.3 < R ≤ 0.7 | Inject on explicit recall only |
| **Cold** | R ≤ 0.3 | Return stubs, hydrate on demand |

### Context Placement

Research shows LLMs attend best to context start and end ("lost-in-the-middle" effect). Place high-value memories strategically:

```typescript
function buildContextInjection(memories: Memory[]): string {
  const hot = memories.filter(m => m.retrievability > 0.7);
  const warm = memories.filter(m => m.retrievability > 0.3 && m.retrievability <= 0.7);
  
  // Hot memories at edges, warm in middle
  const startMemories = hot.slice(0, Math.ceil(hot.length / 2));
  const endMemories = hot.slice(Math.ceil(hot.length / 2));
  
  return [
    formatMemories(startMemories),  // Start of context
    formatMemories(warm),           // Middle (less critical)
    formatMemories(endMemories)     // End of context
  ].join('\n\n');
}
```

### Stub Hydration

For cold memories, return lightweight stubs instead of full content:

```typescript
interface MemoryStub {
  id: string;
  summary: string;      // First 50 chars
  subject?: string;
  retrievability: number;
  age: string;          // "3 days ago"
}

// Agent can request full hydration if needed
async function hydrate(stub: MemoryStub): Promise<Memory> {
  return db.prepare('SELECT * FROM current_beliefs WHERE event_id = ?')
    .get(stub.id);
}
```

---

## Context Pollution Prevention

### Causes of Context Pollution

1. **Accumulation** — agentic workflows dump intermediate results into context
2. **Distractor interference** — semantically related but incorrect content misleads model
3. **Adversarial injection** — malicious content via tool outputs or retrieved documents

### Mitigations

| Strategy | Implementation |
|----------|----------------|
| **Just-in-time retrieval** | Return stubs, hydrate on demand (see above) |
| **FSRS filtering** | Low-R memories excluded from recall results |
| **Confidence threshold** | Skip memories with confidence < 0.3 |
| **Source-tier tracking** | Weight authoritative sources higher |

### Source Tier

Track where memories came from for provenance:

```sql
-- Add to memory_events schema
source_tier TEXT CHECK(source_tier IN (
  'authoritative',  -- Official docs, .gov, .edu
  'validated',      -- Curated data, verified sources
  'observed',       -- Agent observations, tool outputs
  'inferred'        -- Synthesized from other memories
)) DEFAULT 'observed'
```

### Anomaly Detection (v2)

Future: flag incoming memories that conflict with high-confidence existing beliefs.

```typescript
async function checkAnomaly(newContent: string, subject: string): Promise<boolean> {
  const existing = await recall(subject, { types: ['factual'], limit: 5 });
  
  // If new content contradicts high-confidence existing beliefs, flag it
  for (const m of existing) {
    if (m.confidence > 0.8) {
      const similarity = await cosineSimilarity(newContent, m.content);
      if (similarity < 0.3) {
        // Potential contradiction — flag for review
        return true;
      }
    }
  }
  return false;
}
```

---

## Multi-Agent Concurrency

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                                  │
└─────────────────────────────────────────────────────────────────────┘
         │
         │ spawns
         ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Agent A    │  │  Agent B    │  │  Agent C    │  │  Agent D    │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
         │              │              │              │
         └──────────────┴──────────────┴──────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   SHARED MEMORY     │
                    │                     │
                    │  Event Log (append) │
                    │  Projection (derive)│
                    │  Event Bus (notify) │
                    └─────────────────────┘
```

### Concurrency Model

| Operation | Concurrency | Mechanism |
|-----------|-------------|-----------|
| **Read** | Fully concurrent | SQLite WAL, no locks |
| **Append event** | Concurrent | Always succeeds (append-only) |
| **Update projection** | Serialized | Per-subject lock or single writer |
| **Notify** | Async | Event bus with sequence numbers |

### Conflict Detection

```typescript
async function appendEvent(
  db: Database,
  event: MemoryEvent
): Promise<{ conflictsWith?: string[] }> {
  // 1. Get current version vector for subject
  const current = db.prepare(`
    SELECT event_id, version_vector 
    FROM memory_events 
    WHERE namespace = ? AND subject_hash = ?
    ORDER BY recorded_at DESC LIMIT 1
  `).get(event.namespace, event.subjectHash);
  
  // 2. Compute new version vector
  const currentVV = current ? JSON.parse(current.version_vector) : {};
  const newVV = increment(currentVV, event.agentId);
  event.versionVector = JSON.stringify(newVV);
  
  // 3. Append event (always succeeds)
  db.prepare(`INSERT INTO memory_events (...) VALUES (...)`).run(event);
  
  // 4. Check for conflicts
  if (current && !dominates(newVV, JSON.parse(current.version_vector))) {
    // Concurrent write detected
    return { conflictsWith: [current.event_id] };
  }
  
  // 5. Update projection
  updateProjection(db, event);
  
  return {};
}
```

### Event Bus

```typescript
interface MemoryEvent {
  type: 'learned' | 'recalled' | 'superseded' | 'reinforced' | 'conflict';
  eventId: string;
  agentId: string;
  sequenceNumber: number;  // Monotonic, for ordering
  subject?: string;
  timestamp: number;
}

class EventBus {
  private sequence = 0;
  private subscribers = new Map<string, EventHandler>();
  private buffer: MemoryEvent[] = [];
  
  emit(event: Omit<MemoryEvent, 'sequenceNumber'>): void {
    const fullEvent = { ...event, sequenceNumber: ++this.sequence };
    this.buffer.push(fullEvent);
    
    // Notify all except sender
    for (const [agentId, handler] of this.subscribers) {
      if (agentId !== event.agentId) {
        handler(fullEvent);
      }
    }
  }
  
  // Agents can replay from a sequence number (catch-up after disconnect)
  replay(fromSequence: number): MemoryEvent[] {
    return this.buffer.filter(e => e.sequenceNumber > fromSequence);
  }
}
```

### Conflict Resolution Strategies

```typescript
type ConflictStrategy = 'confidence' | 'latest' | 'judge' | 'keep_both';

interface ConflictResolution {
  strategy: ConflictStrategy;
  confidenceThreshold: number;  // for 'confidence' strategy
}

async function resolveConflict(
  db: Database,
  eventA: MemoryEvent,
  eventB: MemoryEvent,
  config: ConflictResolution
): Promise<string> {  // returns winning event_id
  
  switch (config.strategy) {
    case 'confidence':
      // Higher confidence wins, if difference > threshold
      if (Math.abs(eventA.confidence - eventB.confidence) > config.confidenceThreshold) {
        return eventA.confidence > eventB.confidence ? eventA.eventId : eventB.eventId;
      }
      // Fall through to 'latest' if similar confidence
      
    case 'latest':
      return eventA.recordedAt > eventB.recordedAt ? eventA.eventId : eventB.eventId;
      
    case 'keep_both':
      // Mark as siblings, don't resolve
      return 'both';
      
    case 'judge':
      // Spawn judge agent (async, returns later)
      throw new Error('Judge resolution requires async handling');
  }
}
```

### Crash Recovery

| Scenario | Problem | Solution |
|----------|---------|----------|
| Crash after append, before projection | Stale projection | Rebuild projection on startup |
| Crash after event emit, before commit | Phantom events | Events emitted AFTER commit |
| Agent dies mid-operation | Orphaned locks | Heartbeat timeout, lock release |
| Projection corruption | Invalid state | Drop and rebuild from event log |

```typescript
async function startup(db: Database): Promise<void> {
  // 1. Check if projection is stale
  const lastEvent = db.prepare(`
    SELECT MAX(recorded_at) as last FROM memory_events
  `).get();
  
  const lastProjection = db.prepare(`
    SELECT MAX(recorded_at) as last FROM current_beliefs
  `).get();
  
  // 2. Rebuild if needed
  if (lastEvent.last > (lastProjection.last ?? 0)) {
    console.log('[memory] Rebuilding projection from event log...');
    rebuildProjection(db);
  }
}
```

---

## MCP Tools

### Core Operations

```typescript
const MEMORY_TOOLS = [
  {
    name: 'memory_recall',
    description: 'Search memory for relevant context. Hot memories (R>0.7) return full content; cold memories (R<0.3) return stubs unless include_cold=true.',
    parameters: {
      query: { type: 'string', description: 'What to search for' },
      namespace: { type: 'string', description: 'Memory namespace (default: current project)' },
      types: { type: 'array', items: { enum: ['episodic', 'factual', 'procedural'] } },
      limit: { type: 'number', default: 10 },
      min_retrievability: { type: 'number', default: 0.1 },
      include_cold: { type: 'boolean', default: false, description: 'If true, hydrate cold memories instead of returning stubs' }
    }
  },
  {
    name: 'memory_learn',
    description: 'Store a fact (will supersede existing facts about same subject)',
    parameters: {
      content: { type: 'string' },
      subject: { type: 'string', description: 'What this fact is about (e.g., auth.oauth)' },
      namespace: { type: 'string' },
      confidence: { type: 'number', default: 0.8, minimum: 0, maximum: 1 }
    }
  },
  {
    name: 'memory_remember',
    description: 'Store an episodic memory (observation, event)',
    parameters: {
      content: { type: 'string' },
      namespace: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } }
    }
  },
  {
    name: 'memory_skill',
    description: 'Store a procedural memory (how to do something)',
    parameters: {
      content: { type: 'string' },
      subject: { type: 'string', description: 'What skill this is (e.g., deploy.prod)' },
      namespace: { type: 'string' }
    }
  },
  {
    name: 'memory_forget',
    description: 'Explicitly retract a memory (GDPR, user correction)',
    parameters: {
      event_id: { type: 'string' },
      reason: { type: 'string', enum: ['user_request', 'correction', 'gdpr'] }
    }
  },
  {
    name: 'memory_history',
    description: 'Get the evolution of a belief over time',
    parameters: {
      subject: { type: 'string' },
      namespace: { type: 'string' }
    }
  },
  {
    name: 'memory_explain',
    description: 'Debug why a memory was/wasn\'t recalled',
    parameters: {
      query: { type: 'string' },
      namespace: { type: 'string' }
    },
    returns: {
      candidates: 'Array of memories with similarity scores, retrievability, final rank'
    }
  },
  {
    name: 'memory_stats',
    description: 'Get memory health statistics',
    parameters: {
      namespace: { type: 'string' }
    },
    returns: {
      total: 'number',
      by_type: '{ episodic, factual, procedural }',
      avg_retrievability: 'number',
      conflicts: 'number',
      low_r_count: 'number (R < 0.1)'
    }
  },
  {
    name: 'memory_conflicts',
    description: 'List unresolved conflicts for manual resolution',
    parameters: {
      namespace: { type: 'string' }
    }
  },
  {
    name: 'memory_resolve',
    description: 'Resolve a conflict by picking a winner',
    parameters: {
      conflict_id: { type: 'string' },
      winner: { type: 'string', description: 'event_id of winning version' },
      reason: { type: 'string' }
    }
  }
];
```

---

## Consolidation

### When to Run

| Trigger | Frequency |
|---------|-----------|
| Session end | Always |
| Periodic (daemon mode) | Every 30 minutes |
| Manual | `/memory consolidate` command |
| Startup | If projection stale |

### Process

```typescript
async function consolidate(db: Database, namespace: string): Promise<ConsolidationResult> {
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;
  
  // 1. Update all retrievabilities
  const beliefs = db.prepare(`
    SELECT event_id, stability, last_recall, recorded_at 
    FROM current_beliefs 
    WHERE namespace = ?
  `).all(namespace);
  
  for (const b of beliefs) {
    const lastRecall = b.last_recall ?? b.recorded_at;
    const daysSince = (now - lastRecall) / dayMs;
    const R = computeRetrievability(b.stability, daysSince);
    
    db.prepare(`UPDATE current_beliefs SET retrievability = ? WHERE event_id = ?`)
      .run(R, b.event_id);
  }
  
  // 2. Identify very low-R items
  const lowR = db.prepare(`
    SELECT event_id, memory_type FROM current_beliefs
    WHERE namespace = ? AND retrievability < 0.01
  `).all(namespace);
  
  // 3. Archive episodic (don't delete, mark cold)
  // Procedural/factual stay even at low R (expensive to relearn)
  const archived = lowR.filter(i => i.memory_type === 'episodic');
  
  // 4. Prune old superseded events (keep last 10 per subject)
  const pruned = pruneOldEvents(db, namespace, 10);
  
  // 5. Rebuild any stale indexes
  db.exec('ANALYZE');
  
  return {
    updated: beliefs.length,
    archived: archived.length,
    pruned,
    conflicts: countConflicts(db, namespace)
  };
}
```

---

## Local Models

### Embedding: nomic-embed-text v1.5

| Property | Value |
|----------|-------|
| Size | 274MB |
| Dimensions | 768 |
| Context | 8192 tokens |
| CPU speed | ~20-50ms per embed |
| Install | `ollama pull nomic-embed-text` |

### Fallback: transformers.js

For environments without Ollama:

```typescript
// Note: @huggingface/transformers is the maintained package (took over from @xenova)
import { pipeline } from '@huggingface/transformers';

class TransformersEmbedder implements Embedder {
  private embedder: any;
  readonly dimensions = 768;
  
  async init(): Promise<void> {
    // Cold start: 2-5s to load model
    this.embedder = await pipeline(
      'feature-extraction', 
      'nomic-ai/nomic-embed-text-v1.5',
      { dtype: 'q4' }  // quantized for smaller size
    );
  }
  
  async embed(text: string): Promise<Float32Array> {
    const result = await this.embedder(text, { 
      pooling: 'mean', 
      normalize: true 
    });
    return new Float32Array(result.data);
  }
}
```

### Distillation: Qwen2.5 3B (Q4_K_M)

| Property | Value |
|----------|-------|
| Size | ~2.5GB |
| Speed | ~8 tok/s on CPU |
| Use | Trace → skill extraction, summarization |
| Install | `ollama pull qwen2.5:3b` |

### Graceful Degradation

```typescript
async function createEmbedder(): Promise<Embedder> {
  // Try Ollama first
  try {
    const ollama = new OllamaEmbedder();
    await ollama.healthCheck();
    return ollama;
  } catch {
    console.warn('[memory] Ollama not available, falling back to transformers.js');
  }
  
  // Fall back to transformers.js
  const tfjs = new TransformersEmbedder();
  await tfjs.init();
  return tfjs;
}
```

---

## CLI Commands

```bash
# Health check
veil-memory doctor

# Stats
veil-memory stats [--namespace=default]

# Manual consolidation
veil-memory consolidate [--namespace=default]

# List conflicts
veil-memory conflicts [--namespace=default]

# Export (backup)
veil-memory export --output=backup.json [--namespace=default]

# Import (restore)
veil-memory import --input=backup.json [--namespace=default]

# Rebuild projection from event log
veil-memory rebuild [--namespace=default]

# Re-embed all (after model upgrade)
veil-memory reembed [--model=nomic-embed-text-v1.5]
```

---

## File Structure

```
packages/
  veil-memory/
    src/
      index.ts              # Main exports
      store.ts              # MemoryStore class
      types.ts              # Type definitions
      schema.ts             # SQL schema + migrations
      
      fsrs.ts               # FSRS decay engine
      version-vector.ts     # Version vector logic
      projection.ts         # Current state projection
      
      embedder/
        index.ts            # Embedder interface
        ollama.ts           # Ollama implementation
        transformers.ts     # transformers.js fallback
      
      multi-agent/
        shared-memory.ts    # SharedMemory class
        event-bus.ts        # Event notification
        conflict.ts         # Conflict resolution
      
      mcp/
        server.ts           # MCP server
        tools.ts            # Tool definitions
      
      ui/
        cat.ts              # ASCII cat widget
        annotations.ts      # Inline annotations
      
      cli/
        doctor.ts           # Health check
        stats.ts            # Statistics
        consolidate.ts      # Manual consolidation
        
    test/
      store.test.ts
      fsrs.test.ts
      version-vector.test.ts
      supersession.test.ts
      conflict.test.ts
      projection.test.ts
```

---

## Integration Points

### Hermes

| Hook | Purpose |
|------|---------|
| `plugins/memory/` | Memory provider slot |
| Pre-prompt assembly | Inject relevant memories |
| Compression event | Distill before discard (future) |

### OpenClaw

| Hook | Purpose |
|------|---------|
| MCP tools | Primary integration |
| Context compaction | Distill before discard (future) |

### Claude Code

| Hook | Purpose |
|------|---------|
| MCP server | Tool access |
| Auto-memory hooks | `/remember` passthrough |

---

## Research Sources

### Context Rot & Pollution
- Chroma context rot study (2025) — 18 models tested, lost-in-the-middle effect
- Anthropic context engineering guide — just-in-time retrieval, context curation
- arXiv 2601.11564 — KV-cache growth and degradation correlation
- arXiv 2604.08304 — RAG security taxonomy, attacks and defenses
- A2AS defense framework (arXiv 2510.13825) — reduces injection from 73% to 8.7%

### Concurrency Models
- CRDTs (LWW-Register, MV-Register) — conflict-free replicated data types
- Version vectors / Dotted Version Vectors — causal ordering
- cr-sqlite (vlcn.io) — CRDT SQLite extension
- Event sourcing — append-only log with derived projections

### Agent Memory Systems
- Letta v1 (MemGPT successor) — self-managing memory via tool calls, 91% lower latency
- Mem0 — hybrid retrieval, but no supersession/versioning
- Zep/Graphiti — temporally-aware knowledge graph
- Cognee — local-first KG with versioning
- Hierarchical memory (hot/warm/cold) — dominant 2026 production pattern

### FSRS
- FSRS v5/v7 — power-law forgetting curve, R=0.9 at t=S calibration
- Key insight: retrieval = consolidation event
- CraniMem (arXiv 2603.15642) — hippocampal-cortical architecture

### Procedural Memory
- Voyager — skill library as runnable JS, 15x speedup
- ProcMEM (ICML 2026) — Skill-MDP, Non-Parametric PPO
- AWM — workflow routines distilled from trajectories

### Memory Robustness
- RobustRAG — reliability-aware aggregation against retrieval corruption
- Conflict-based scoring (Astute RAG) — parametric vs retrieved comparison
- SafeRAG benchmark (2025) — catalogued attack classes and defense gaps

### sqlite-vec
- v0.1.9 (March 2026), active development
- Brute-force KNN with SIMD, ANN planned
- Works with better-sqlite3, prebuilt binaries

---

## MVP vs Future

### MVP (v1)
- Event log schema + migrations
- FSRS decay with configurable constants
- Core MCP tools: recall, learn, remember, skill, forget
- Ollama embedder
- SQLite + sqlite-vec
- Basic cat widget (3 states)
- Retrievability tiers (hot/warm/cold filtering)

### Future (v2+)
- Version vectors + conflict resolution
- Judge agent for conflicts
- transformers.js fallback
- Qwen distillation (trace → skill)
- Cross-device sync
- Anomaly detection on ingest
- Full cat animation
- Most CLI commands

---

## Open Questions

1. **Procedural distillation**: How do we detect repeated patterns and extract skills automatically?
2. **Cross-device sync**: For managed service, how do we merge event logs from multiple devices?
3. **Namespace isolation**: Should agents be able to read other namespaces? Access control model?
4. **Embedding migration**: When model upgrades, re-embed incrementally or all at once?
5. **Judge agent**: For conflict resolution, what's the judge prompt? Latency budget?

---

## Next Steps

1. [x] Implement event log schema + migrations
2. [x] Implement version vector logic
3. [x] Implement projection + rebuild
4. [x] Add FSRS decay engine with edge case handling
5. [ ] Build MCP server with all tools
6. [ ] Add transformers.js fallback
7. [x] Create ASCII cat widget with config
8. [ ] Add CLI commands (doctor, stats, consolidate)
9. [ ] Wire engrammic cold storage to veil-memory
10. [ ] Test with Veil harness
11. [ ] Test with external harness (Hermes/OpenClaw)
12. [ ] Build managed service layer

---

*Last updated: 2026-06-18 (v3 — MVP phase 1 impl complete)*
