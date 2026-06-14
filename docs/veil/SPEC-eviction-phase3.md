# Phase 3: Eviction Mechanics Design

**Status**: Approved  
**Date**: 2026-06-14  
**Branch**: `feat/engrammic-eviction`

## Overview

Implement eviction mechanics for the engrammic memory system: enhanced scoring with source awareness, adaptive thresholds, recall cooldowns, two-phase warm-to-cold commit, and circuit breaker for cold storage failures.

This phase focuses on mechanics only. UX features (status bar, faded history) are deferred to Phase 4.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      ContextManager                              │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │   Scorer    │  │EvictionController│  │  CircuitBreaker  │   │
│  │             │  │                  │  │                  │   │
│  │ - source mod│  │ - adaptive thresh│  │ - failure count  │   │
│  │ - half-life │  │ - recall cooldown│  │ - open/closed    │   │
│  │             │  │ - cascade logic  │  │ - auto-reset     │   │
│  └─────────────┘  └──────────────────┘  └──────────────────┘   │
│                              │                    │              │
│                              ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    ContextCache                          │   │
│  │  - two-phase commit (markEvicting/deleteEvicting)        │   │
│  │  - crash recovery (recoverEvicting)                      │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Scorer Enhancements (`scorer.ts`)

#### Source Modifier

Explicit items (agent-initiated `remember()`) score 1.5x higher than auto-captured items:

```typescript
const sourceMod = item.source === 'explicit' ? 1.5 : 1.0;
return base * typeMod * sourceMod;
```

#### Per-Item Half-Life

Replace global decay with source-aware half-life:

```typescript
// Explicit items decay slower (4 hours vs 30 minutes)
const halfLife = item.source === 'explicit' ? 240 : 30; // minutes
const ageMinutes = (Date.now() - item.lastAccess) / 60000;
const recency = Math.pow(0.5, ageMinutes / halfLife);
```

### 2. Eviction Controller (`eviction.ts`)

New module managing eviction state and orchestration.

#### State

```typescript
interface EvictionState {
  threshold: number;           // current trigger (0.60-0.85 range)
  recentEvictions: number;     // count in last 60 seconds
  lastEvictionTime: number;    // timestamp
  cooldowns: Map<string, number>; // itemId -> turn when recalled
}
```

#### Adaptive Threshold

```typescript
function adjustThreshold(state: EvictionState): void {
  const now = Date.now();
  const timeSinceLastEviction = now - state.lastEvictionTime;

  // Thrashing: 3+ evictions in 60 seconds -> lower threshold
  if (state.recentEvictions >= 3) {
    state.threshold = Math.max(0.60, state.threshold - 0.05);
  }
  // Stable: no eviction for 5+ minutes -> raise threshold
  else if (timeSinceLastEviction > 300000) {
    state.threshold = Math.min(0.85, state.threshold + 0.05);
  }
}
```

#### Recall Cooldown

Items recalled/promoted in the last 5 turns are immune to eviction:

```typescript
function isOnCooldown(itemId: string, currentTurn: number, cooldowns: Map<string, number>): boolean {
  const recalledAt = cooldowns.get(itemId);
  if (recalledAt === undefined) return false;
  return (currentTurn - recalledAt) < 5;
}
```

#### Per-Item Size Cap

Items exceeding 20% of budget are truncated:

```typescript
function enforceItemSizeCap(item: ContextItem, budgetTokens: number): ContextItem {
  const maxTokens = Math.floor(budgetTokens * 0.20);
  const itemTokens = estimateTokens(item.content);

  if (itemTokens > maxTokens) {
    item.content = smartTruncate(item.content, maxTokens * 4);
    item.tags.push('truncated');
  }

  return item;
}
```

#### Cascade Flow

Same 3-stage cascade as before, but Stage 2 respects cooldowns:

1. **Stage 1 (Stale)**: Items >2hr old with accessCount=1 -> warm
2. **Stage 2 (Low-score)**: Score <0.3, NOT pinned, NOT on cooldown -> warm
3. **Stage 3 (Force)**: If still over budget, evict lowest-scoring unpinned items

### 3. Circuit Breaker (`circuit-breaker.ts`)

Protects against cold storage failures.

#### State

```typescript
interface CircuitBreakerState {
  failures: number;
  isOpen: boolean;
  openedAt: number;
  resetTimeout: number; // 300000ms (5 minutes)
}
```

#### Behavior

- **Closed**: All calls pass through
- **Open**: Calls skip cold storage, items stay in warm cache
- **Half-open**: After timeout, next call is a probe

Transitions:
- 3 consecutive failures -> OPEN
- Probe succeeds -> CLOSED
- Probe fails -> OPEN (reset timer)

#### API

```typescript
class CircuitBreaker {
  async execute<T>(fn: () => Promise<T>): Promise<T | null>;
  isOpen(): boolean;
  reset(): void;
}
```

### 4. Cache Two-Phase Commit (`cache.ts`)

Safe warm-to-cold demotion with crash recovery.

#### Schema Addition

```sql
ALTER TABLE items ADD COLUMN evicting INTEGER DEFAULT 0;
```

#### New Methods

```typescript
markEvicting(id: string): void;     // Phase 1: set flag
unmarkEvicting(id: string): void;   // Rollback on failure
deleteEvicting(id: string): void;   // Phase 2: confirm delete
recoverEvicting(): ContextItem[];   // Startup: find stuck items
```

#### Flow

```
markEvicting(id)
       │
       ▼
cold.demote(item)
       │
  ┌────┴────┐
  │ success │ failure
  ▼         ▼
deleteEvicting(id)    unmarkEvicting(id)
                      circuitBreaker.recordFailure()
```

#### Crash Recovery

On `ContextCache` initialization:

```typescript
const stuck = this.recoverEvicting();
for (const item of stuck) {
  this.unmarkEvicting(item.id);
  console.warn(`Recovered stuck item: ${item.id}`);
}
```

### 5. Type Updates (`types.ts`)

#### ContextItem Addition

```typescript
interface ContextItem {
  // ... existing fields
  source: 'auto' | 'explicit';
}
```

#### Config Additions

```typescript
interface ContextManagerConfig {
  // ... existing fields

  // Eviction thresholds
  evictionThresholdMin: number;     // 0.60
  evictionThresholdMax: number;     // 0.85
  evictionThresholdDefault: number; // 0.70

  // Cooldowns
  recallCooldownTurns: number;      // 5

  // Per-item limits
  maxItemBudgetRatio: number;       // 0.20

  // Warm cache
  warmCacheMaxItems: number;        // 1000

  // Circuit breaker
  coldFailureThreshold: number;     // 3
  coldCircuitResetMs: number;       // 300000
}
```

## Integration Points

### Manager Updates

`ContextManager` delegates eviction to `EvictionController`:

```typescript
class ContextManager {
  private eviction: EvictionController;
  private circuitBreaker: CircuitBreaker;

  async checkEviction(taskCtx: TaskContext): Promise<EvictionCandidate[]> {
    return this.eviction.checkAndEvict(
      this.loaded,
      this.budget,
      taskCtx,
      this.config,
      (item) => this.demoteToCold(item)
    );
  }

  private async demoteToCold(item: ContextItem): Promise<void> {
    this.cache.markEvicting(item.id);

    const result = await this.circuitBreaker.execute(() =>
      this.cold.demote(item)
    );

    if (result !== null) {
      item.kgPointer = result;
      this.cache.deleteEvicting(item.id);
    } else {
      this.cache.unmarkEvicting(item.id);
    }
  }
}
```

### Harness Updates

`VeilHarness` calls `eviction.setRecallCooldown()` when `promote` tool is used.

## Testing Strategy

| Component | Test Focus |
|-----------|------------|
| Scorer | Source modifier math, half-life decay curves |
| EvictionController | Threshold adaptation, cooldown immunity, cascade order |
| CircuitBreaker | State transitions, timeout behavior, probe logic |
| Cache | Two-phase commit, crash recovery, evicting flag |

All tests use vitest. Mock cold storage for circuit breaker tests.

## File Changes Summary

| File | Change |
|------|--------|
| `types.ts` | Add `source` field, new config fields |
| `scorer.ts` | Add source modifier, per-item half-life |
| `eviction.ts` | NEW: EvictionController class |
| `circuit-breaker.ts` | NEW: CircuitBreaker class |
| `cache.ts` | Add evicting column, two-phase methods |
| `manager.ts` | Integrate EvictionController, CircuitBreaker |
| `harness.ts` | Call setRecallCooldown on promote |

## Out of Scope (Phase 4)

- Status bar context indicator
- Faded history rendering
- `/context` command improvements
- Eviction notifications
- Debug mode tick visibility
