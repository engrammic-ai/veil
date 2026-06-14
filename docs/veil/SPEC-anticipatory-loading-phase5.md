# Anticipatory Loading (Phase 5)

**Status**: Draft  
**Date**: 2026-06-14  
**Depends on**: Phase 3 Eviction, Phase 4 UX  
**Package**: `packages/engrammic`

## Goal

Preemptively surface relevant context before the agent asks for it, without consuming token budget until explicitly requested.

## Dependencies

Existing interfaces this spec relies on:

| Interface | Location | Used For |
|-----------|----------|----------|
| `ContextCache` | `src/cache.ts` | `getByTags()`, `getAll()` queries |
| `ContextItem` | `src/types.ts` | Item schema with `id`, `tags`, `type`, `lastAccess` |
| `VeilHarness.load(ids)` | `src/harness.ts` | Load items into hot context by ID |
| `VeilHarness.getUsage()` | `src/harness.ts` | Get current budget percentage |
| `formatRelativeTime()` | `src/utils.ts` | Format timestamps as "2min ago" (NEW - add if missing) |

## Core Principle

**Metadata-first**: Show the agent what EXISTS, let it decide what to HYDRATE.

```
User: "let's fix the auth tests"

Harness detects: "auth", "test"
  -> Queries warm cache for matches
  -> Returns manifest (lightweight summary)
  -> Agent sees available context
  -> Agent calls `recall` tool to hydrate specific items
  -> Token budget only spent on hydration
```

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ User Msg    │ --> │ Trigger      │ --> │ Manifest    │
│             │     │ Matcher      │     │ Builder     │
└─────────────┘     └──────────────┘     └─────────────┘
                           │                    │
                    ┌──────┴──────┐      ┌──────┴──────┐
                    │ Triggers    │      │ Warm Cache  │
                    │ (in-memory) │      │ (SQLite)    │
                    └─────────────┘      └─────────────┘
```

**Harness** owns pattern matching and manifest building (core context logic).  
**Extension** surfaces manifest to agent via context injection.

**Note**: Phase 5 queries warm cache only. Cold storage queries deferred to Phase 6.

## Hydration Protocol

Agent hydrates items via the existing `recall` tool:

```typescript
// Agent sees manifest with IDs, then calls:
recall({ ids: ["eng_001", "fact_042"] })

// Or by tag:
recall({ tags: ["auth"] })
```

No new tools needed. Existing `recall` already supports ID and tag-based retrieval.

### Hydration Tracking (Stub for Phase 6)

Track when agent hydrates items from manifest for future learning:

```typescript
// In harness.ts - stub for Phase 6 learning
private manifestItemIds: Set<string> = new Set();

// Called when manifest is built
private trackManifestItems(manifest: ContextManifest): void {
  this.manifestItemIds.clear();
  for (const item of manifest.items) {
    this.manifestItemIds.add(item.id);
  }
}

// Called from recall tool handler
onRecall(ids: string[]): void {
  for (const id of ids) {
    if (this.manifestItemIds.has(id)) {
      // Phase 6: log hydration event for learning
      // console.log(`[veil] hydrated from manifest: ${id}`);
    }
  }
}
```

## Triggers

### Trigger Schema

```typescript
interface Trigger {
  id: string;
  pattern: RegExp;
  negative?: RegExp;        // If matches, trigger doesn't fire
  type: "keyword" | "file" | "command";
  action: {
    tags?: string[];
    type?: ContextItemType;
  };
  priority: number;         // Higher = checked first
  enabled: boolean;
}
```

**Note**: Trigger types `"file"` and `"command"` are schema-ready but not implemented in Phase 5. Default triggers use `"keyword"` only. File/command triggers deferred to Phase 6.

### Default Triggers

```typescript
const DEFAULT_TRIGGERS: Trigger[] = [
  { 
    id: "test",
    pattern: /\b(run|fix|write|check)\s+(the\s+)?tests?\b/i,
    negative: /test\s+(this|that|it|the\s+idea)/i,  // Exclude "test this idea"
    type: "keyword",
    action: { tags: ["test"] },
    priority: 10,
    enabled: true,
  },
  { 
    id: "debug",
    pattern: /\bdebug(ging)?\b/i,
    type: "keyword",
    action: { tags: ["debug", "error"] },
    priority: 10,
    enabled: true,
  },
  { 
    id: "auth",
    pattern: /\bauth(entication|orization)?\b/i,
    type: "keyword",
    action: { tags: ["auth"] },
    priority: 10,
    enabled: true,
  },
  { 
    id: "fix",
    pattern: /\bfix(ing|ed)?\s+(the\s+)?(bug|issue|error)/i,
    type: "keyword",
    action: { type: "episodic" },
    priority: 5,
    enabled: true,
  },
];
```

### Trigger Storage

Phase 5: In-memory defaults only. Custom trigger persistence deferred to Phase 6.

## Manifest Format

Flat list for simplicity:

```typescript
interface ContextManifest {
  triggers: string[];        // Trigger IDs that fired
  budgetPercent: number;     // Budget at query time (pre-preload)
  items: ManifestItem[];     // Max 10
}

interface ManifestItem {
  id: string;
  type: ContextItemType;
  tags: string[];
  summary: string;           // First 50 chars
  age: string;               // "2min ago", "1hr ago"
}
```

### Manifest Injection

Injected after user message, before agent response:

```xml
<veil-available>
Relevant context found (use recall to load):

- eng_001 [test] "auth test failures from..." (2min ago)
- eng_002 [test] "test helper for mocking..." (5min ago)  
- fact_042 [auth] "OAuth2 flow uses PKCE..." (1hr ago)

Budget: 48% used
</veil-available>
```

**Note on budget display**: The percentage shown is captured *before* any eager preloading. If preload runs (budget < 50%), actual usage will be higher than displayed. This is intentional - the manifest is a snapshot at query time. Agent can check live budget via `/context` command if precision needed.

## Budget-Aware Behavior

| Budget Used | Behavior |
|-------------|----------|
| < 50% | Show manifest, preload top 3 |
| 50-70% | Manifest only, no preloading |
| > 70% | No manifest (skip query to save resources) |

No hysteresis for Phase 5. Add if oscillation observed in practice.

### Preloading (Eager Mode)

When budget < 50%, automatically load top 3 highest-scored items:

```typescript
async function preloadTopItems(
  manifest: ContextManifest,
  harness: VeilHarness,
  limit: number = 3
): Promise<void> {
  const ids = manifest.items.slice(0, limit).map(i => i.id);
  harness.load(ids);  // Uses existing load() - handles dedup internally
}
```

### Preload + Recall Race

If agent calls `recall` for an item that was preloaded:
- `harness.load(ids)` is idempotent - loading an already-loaded item is a no-op
- No double-loading or budget double-counting
- This is handled by existing `load()` implementation which checks if item is already in hot context

## Implementation

### Files to Create/Modify

| File | Change |
|------|--------|
| `src/anticipate.ts` | NEW: Trigger matcher, manifest builder |
| `src/harness.ts` | Add `processUserMessage()` async method |
| `src/extension.ts` | Inject manifest on user message |
| `src/types.ts` | Add Trigger, Manifest types |
| `src/utils.ts` | Add `formatRelativeTime()` if missing |

### Utility Function

```typescript
// src/utils.ts

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}hr ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
```

### Core Functions

```typescript
// src/anticipate.ts

import { formatRelativeTime } from "./utils.ts";
import type { ContextCache } from "./cache.ts";
import type { ContextItem, ContextItemType } from "./types.ts";

/**
 * Match triggers against user message.
 * Returns deduplicated list of matching triggers.
 */
export function matchTriggers(
  message: string, 
  triggers: Trigger[]
): Trigger[] {
  const matched: Trigger[] = [];
  const seenActions = new Set<string>();
  
  // Sort by priority descending
  const sorted = [...triggers].sort((a, b) => b.priority - a.priority);
  
  for (const trigger of sorted) {
    if (!trigger.enabled) continue;
    if (!trigger.pattern.test(message)) continue;
    if (trigger.negative?.test(message)) continue;
    
    // Deduplicate by action (avoid querying same tags twice)
    const actionKey = JSON.stringify(trigger.action);
    if (seenActions.has(actionKey)) continue;
    seenActions.add(actionKey);
    
    matched.push(trigger);
  }
  
  return matched;
}

/**
 * Build manifest from matched triggers.
 * Queries warm cache only (Phase 5).
 */
export async function buildManifest(
  triggers: Trigger[],
  cache: ContextCache,
  budget: { percent: number }
): Promise<ContextManifest | null> {
  if (triggers.length === 0) return null;
  if (budget.percent > 70) return null;
  
  const items: ManifestItem[] = [];
  const seenIds = new Set<string>();
  
  for (const trigger of triggers) {
    let matches: ContextItem[] = [];
    
    if (trigger.action.tags) {
      matches = cache.getByTags(trigger.action.tags, 10);
    } else if (trigger.action.type) {
      matches = cache.getAll().filter(i => i.type === trigger.action.type);
    }
    
    for (const item of matches) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      
      items.push({
        id: item.id,
        type: item.type,
        tags: item.tags,
        summary: item.content.slice(0, 50).replace(/\n/g, " "),
        age: formatRelativeTime(item.lastAccess),
      });
      
      if (items.length >= 10) break;
    }
    
    if (items.length >= 10) break;
  }
  
  if (items.length === 0) return null;
  
  return {
    triggers: triggers.map(t => t.id),
    budgetPercent: budget.percent,
    items,
  };
}

export function formatManifest(manifest: ContextManifest): string {
  const lines = ["<veil-available>", "Relevant context found (use recall to load):", ""];
  
  for (const item of manifest.items) {
    const tags = item.tags.slice(0, 2).join(", ");
    lines.push(`- ${item.id} [${tags}] "${item.summary}..." (${item.age})`);
  }
  
  lines.push("", `Budget: ${manifest.budgetPercent.toFixed(0)}% used`, "</veil-available>");
  return lines.join("\n");
}
```

### Harness Integration

```typescript
// In harness.ts

private triggers: Trigger[] = DEFAULT_TRIGGERS;
private manifestItemIds: Set<string> = new Set();  // For Phase 6 learning

async processUserMessage(message: string): Promise<string | null> {
  const triggers = matchTriggers(message, this.triggers);
  if (triggers.length === 0) return null;
  
  const budget = this.getUsage();
  if (budget.percent > 70) return null;
  
  let manifest: ContextManifest | null;
  try {
    manifest = await buildManifest(triggers, this.cache, budget);
  } catch (err) {
    // Log error, don't block agent flow
    console.error("[veil] manifest build failed:", err);
    return null;
  }
  
  if (!manifest) return null;
  
  // Track for Phase 6 learning
  this.trackManifestItems(manifest);
  
  // Eager preload if budget allows
  if (budget.percent < 50) {
    this.preloadTopItems(manifest, 3);
  }
  
  return formatManifest(manifest);
}

private trackManifestItems(manifest: ContextManifest): void {
  this.manifestItemIds.clear();
  for (const item of manifest.items) {
    this.manifestItemIds.add(item.id);
  }
}

private preloadTopItems(manifest: ContextManifest, limit: number): void {
  const ids = manifest.items.slice(0, limit).map(i => i.id);
  this.load(ids);  // Existing method, handles dedup
}
```

### Extension Integration

```typescript
// In extension.ts, add to turn handler or user message hook:

pi.on("user_message", async (event, ctx) => {
  const manifest = await harness.processUserMessage(event.content);
  if (manifest) {
    // Inject as system context for this turn
    ctx.injectContext("veil-anticipate", manifest);
  }
});
```

**Implementation Note**: The `user_message` event and `ctx.injectContext()` API need verification against Pi's actual extension interface. Fallback approaches:

1. If no `user_message` event: Use `turn_start` and extract message from session context
2. If no `injectContext()`: Return manifest string and prepend to system prompt manually

Verify Pi APIs during implementation and adapt accordingly.

## Error Handling

| Error | Handling |
|-------|----------|
| Cache query fails | Log error, return null (no manifest) |
| Manifest build throws | Catch, log, continue without manifest |
| Item evicted before hydration | `recall` returns graceful "not found" |
| Budget race (preload during eviction) | Preload is additive; eviction will clean up |

## Coordination with Eviction

Manifest queries are read-only and point-in-time. If eviction runs concurrently:
- Manifest may include items about to be evicted (stale)
- Agent's `recall` call will get "not found" for evicted items
- This is acceptable for Phase 5; agent retries with different ID

## Testing

1. **Unit**: `matchTriggers()` with positive/negative patterns
2. **Unit**: `buildManifest()` with various cache states
3. **Unit**: Deduplication of overlapping trigger actions
4. **Unit**: `formatRelativeTime()` edge cases
5. **Integration**: Full flow from message to manifest injection
6. **Budget**: Verify no manifest at >70%, preload at <50%
7. **Idempotency**: Preload + recall same item doesn't double-load

## Success Criteria

- Manifest generation < 50ms (warm cache only)
- No false positives on default triggers (negative patterns work)
- Agent successfully hydrates items from manifest
- No budget overruns from preloading
- Preload is idempotent with subsequent recall

## Deferred to Phase 6

- Cold storage queries in manifest
- Custom trigger persistence (user-defined triggers)
- Trigger types `"file"` and `"command"`
- Learned triggers from hydration patterns (use `manifestItemIds` tracking)
- SQLite observability events
- Hysteresis if budget oscillation observed
- Cross-session pattern sharing via KG
