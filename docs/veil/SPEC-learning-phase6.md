# Learning & Cross-Session Episodes (Phase 6)

**Status**: Draft  
**Date**: 2026-06-15  
**Depends on**: Phase 5 Anticipatory Loading  
**Package**: `packages/engrammic`

## Goal

Learn from agent behavior to improve anticipatory loading over time, and enable cross-session episode retrieval.

## Scope

Phase 6 addresses items deferred from Phase 5:

| Feature | Priority | Description |
|---------|----------|-------------|
| Hydration learning | P0 | Track which manifest items get hydrated |
| Trigger generation | P1 | Auto-create triggers from learned patterns |
| Custom trigger persistence | P1 | Save user-defined triggers to SQLite |
| Cold storage queries | P2 | Include cold items in manifest |
| Cross-session episodes | P2 | "What did I try last time?" queries |
| File/command triggers | P3 | Trigger on paths or shell commands |
| Observability events | P3 | SQLite events for debugging |

## Dependencies

Existing interfaces this spec relies on:

| Interface | Location | Used For |
|-----------|----------|----------|
| `manifestItemIds` | `harness.ts` | Track items shown in manifest |
| `wasInManifest(id)` | `harness.ts` | Check if item was in last manifest |
| `recall` tool | `tools.ts` | Agent hydrates items |
| `ColdStore` | `cold/interface.ts` | Cold storage queries |
| `ContextCache` | `cache.ts` | Warm cache + SQLite |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│ Manifest    │ --> │ Hydration    │ --> │ Pattern     │
│ Tracking    │     │ Logger       │     │ Analyzer    │
└─────────────┘     └──────────────┘     └─────────────┘
       │                   │                    │
       │            ┌──────┴──────┐      ┌──────┴──────┐
       │            │ hydrations  │      │ triggers    │
       │            │ (SQLite)    │      │ (SQLite)    │
       │            └─────────────┘      └─────────────┘
       │
       └──────────────────────────────────────────────┐
                                                      │
┌─────────────┐     ┌──────────────┐     ┌───────────┴┐
│ User Msg    │ --> │ Trigger      │ <-- │ Learned +  │
│             │     │ Matcher      │     │ Default    │
└─────────────┘     └──────────────┘     └────────────┘
```

## Part 1: Hydration Learning

### Schema

```sql
-- Track when agent hydrates items from manifest
CREATE TABLE IF NOT EXISTS hydration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  trigger_ids TEXT NOT NULL,        -- JSON array of trigger IDs that fired
  user_message TEXT NOT NULL,       -- Message that generated the manifest
  hydrated_at INTEGER NOT NULL,     -- Unix timestamp
  latency_ms INTEGER,               -- Time from manifest to hydration
  UNIQUE(session_id, item_id, hydrated_at)
);

CREATE INDEX idx_hydration_item ON hydration_events(item_id);
CREATE INDEX idx_hydration_trigger ON hydration_events(trigger_ids);
```

### Tracking Flow

```typescript
// In harness.ts

interface HydrationEvent {
  sessionId: string;
  itemId: string;
  triggerIds: string[];
  userMessage: string;
  hydratedAt: number;
  latencyMs: number;
}

private lastManifestTime: number = 0;
private lastManifestTriggers: string[] = [];
private lastUserMessage: string = "";

// Called when manifest is built (existing)
private trackManifestItems(manifest: ContextManifest, userMessage: string): void {
  this.manifestItemIds.clear();
  for (const item of manifest.items) {
    this.manifestItemIds.add(item.id);
  }
  this.lastManifestTime = Date.now();
  this.lastManifestTriggers = manifest.triggers;
  this.lastUserMessage = userMessage;
}

// Called from recall tool handler
onRecall(ids: string[]): void {
  const now = Date.now();
  for (const id of ids) {
    if (this.manifestItemIds.has(id)) {
      this.logHydration({
        sessionId: this.sessionId ?? "unknown",
        itemId: id,
        triggerIds: this.lastManifestTriggers,
        userMessage: this.lastUserMessage,
        hydratedAt: now,
        latencyMs: now - this.lastManifestTime,
      });
    }
  }
}

private logHydration(event: HydrationEvent): void {
  this.manager.getCache().logHydration(event);
}
```

### Cache Extension

```typescript
// In cache.ts

logHydration(event: HydrationEvent): void {
  this.db.exec(`
    INSERT OR IGNORE INTO hydration_events 
    (session_id, item_id, trigger_ids, user_message, hydrated_at, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    event.sessionId,
    event.itemId,
    JSON.stringify(event.triggerIds),
    event.userMessage,
    event.hydratedAt,
    event.latencyMs,
  ]);
}

getHydrationStats(itemId: string): { count: number; avgLatency: number } {
  const row = this.db.prepare(`
    SELECT COUNT(*) as count, AVG(latency_ms) as avg_latency
    FROM hydration_events WHERE item_id = ?
  `).get(itemId);
  return { count: row.count, avgLatency: row.avg_latency ?? 0 };
}
```

## Part 2: Trigger Learning

### Pattern Analysis

Analyze hydration events to discover new triggers:

```typescript
// src/learning.ts

interface LearnedPattern {
  pattern: string;           // Regex pattern string
  tags: string[];            // Tags to query
  confidence: number;        // 0-1 based on hit rate
  sampleSize: number;        // Number of events analyzed
}

/**
 * Analyze hydration events to find keyword → tag patterns.
 * 
 * Algorithm:
 * 1. Group hydrations by item tags
 * 2. Extract common words from user messages
 * 3. Score by frequency and uniqueness
 * 4. Generate regex patterns for high-confidence matches
 */
export function analyzePatterns(
  events: HydrationEvent[],
  existingTriggers: Trigger[],
  minConfidence: number = 0.7,
  minSamples: number = 3,
): LearnedPattern[] {
  // Group by item tags
  const tagGroups = new Map<string, string[]>(); // tag -> user messages
  
  for (const event of events) {
    const item = cache.get(event.itemId);
    if (!item) continue;
    
    for (const tag of item.tags) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag)!.push(event.userMessage);
    }
  }
  
  const patterns: LearnedPattern[] = [];
  
  for (const [tag, messages] of tagGroups) {
    if (messages.length < minSamples) continue;
    
    // Skip tags already covered by existing triggers
    if (existingTriggers.some(t => t.action.tags?.includes(tag))) continue;
    
    // Extract common words (simple approach)
    const wordCounts = countWords(messages);
    const topWords = getTopWords(wordCounts, 3);
    
    if (topWords.length === 0) continue;
    
    // Calculate confidence: how often do these words appear together?
    const pattern = topWords.map(w => `\\b${escapeRegex(w)}\\b`).join('|');
    const regex = new RegExp(pattern, 'i');
    const matches = messages.filter(m => regex.test(m)).length;
    const confidence = matches / messages.length;
    
    if (confidence >= minConfidence) {
      patterns.push({
        pattern,
        tags: [tag],
        confidence,
        sampleSize: messages.length,
      });
    }
  }
  
  return patterns;
}
```

### Trigger Generation

Convert learned patterns to triggers:

```typescript
// src/learning.ts

export function patternToTrigger(
  pattern: LearnedPattern,
  existingIds: Set<string>,
): Trigger {
  // Generate unique ID
  let id = `learned_${pattern.tags.join('_')}`;
  let suffix = 0;
  while (existingIds.has(id)) {
    id = `learned_${pattern.tags.join('_')}_${++suffix}`;
  }
  
  return {
    id,
    pattern: new RegExp(pattern.pattern, 'i'),
    type: "keyword",
    action: { tags: pattern.tags },
    priority: 5,  // Lower than defaults (10)
    enabled: true,
    learned: true,
    confidence: pattern.confidence,
  };
}
```

### Learning Schedule

Run pattern analysis periodically, not on every request:

```typescript
// In harness.ts

private lastLearnTime: number = 0;
private readonly LEARN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async maybeLearn(): Promise<void> {
  const now = Date.now();
  if (now - this.lastLearnTime < this.LEARN_INTERVAL_MS) return;
  
  this.lastLearnTime = now;
  
  const events = this.manager.getCache().getRecentHydrations(1000);
  const patterns = analyzePatterns(events, this.triggers);
  
  for (const pattern of patterns) {
    const trigger = patternToTrigger(pattern, new Set(this.triggers.map(t => t.id)));
    this.triggers.push(trigger);
    this.persistTrigger(trigger);
  }
}
```

## Part 3: Custom Trigger Persistence

### Schema

```sql
CREATE TABLE IF NOT EXISTS custom_triggers (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  negative_pattern TEXT,
  type TEXT NOT NULL DEFAULT 'keyword',
  action_tags TEXT,              -- JSON array
  action_type TEXT,              -- ContextItemType
  priority INTEGER DEFAULT 10,
  enabled INTEGER DEFAULT 1,
  learned INTEGER DEFAULT 0,     -- 1 if auto-generated
  confidence REAL,               -- For learned triggers
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Persistence API

```typescript
// In cache.ts

persistTrigger(trigger: Trigger): void {
  const now = Date.now();
  this.db.exec(`
    INSERT OR REPLACE INTO custom_triggers
    (id, pattern, negative_pattern, type, action_tags, action_type, 
     priority, enabled, learned, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    trigger.id,
    trigger.pattern.source,
    trigger.negative?.source ?? null,
    trigger.type,
    JSON.stringify(trigger.action.tags ?? []),
    trigger.action.type ?? null,
    trigger.priority,
    trigger.enabled ? 1 : 0,
    trigger.learned ? 1 : 0,
    trigger.confidence ?? null,
    now,
    now,
  ]);
}

loadCustomTriggers(): Trigger[] {
  const rows = this.db.prepare(`
    SELECT * FROM custom_triggers WHERE enabled = 1
  `).all();
  
  return rows.map(row => ({
    id: row.id,
    pattern: new RegExp(row.pattern, 'i'),
    negative: row.negative_pattern ? new RegExp(row.negative_pattern, 'i') : undefined,
    type: row.type as "keyword" | "file" | "command",
    action: {
      tags: row.action_tags ? JSON.parse(row.action_tags) : undefined,
      type: row.action_type ?? undefined,
    },
    priority: row.priority,
    enabled: true,
    learned: row.learned === 1,
    confidence: row.confidence ?? undefined,
  }));
}

deleteTrigger(id: string): void {
  this.db.exec(`DELETE FROM custom_triggers WHERE id = ?`, [id]);
}
```

### Harness Integration

```typescript
// In harness.ts constructor

// Load custom triggers on startup
const customTriggers = this.manager.getCache().loadCustomTriggers();
this.triggers = [...DEFAULT_TRIGGERS, ...customTriggers];
```

## Part 4: Cold Storage Queries

### Manifest Extension

When budget allows, query cold storage for additional context:

```typescript
// In anticipate.ts

export async function buildManifest(
  triggers: Trigger[],
  cache: ContextCache,
  cold: ColdStore | null,
  budget: { percent: number },
): Promise<ContextManifest | null> {
  if (triggers.length === 0) return null;
  if (budget.percent > 70) return null;
  
  const items: ManifestItem[] = [];
  const seenIds = new Set<string>();
  
  // Query warm cache first (existing logic)
  for (const trigger of triggers) {
    // ... existing warm cache logic ...
  }
  
  // Query cold storage if budget allows and we have capacity
  if (cold && budget.percent < 40 && items.length < 10) {
    const coldItems = await queryCold(triggers, cold, 10 - items.length);
    for (const item of coldItems) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push({
        ...item,
        source: "cold",  // Mark as cold for UI distinction
      });
    }
  }
  
  // ... rest of existing logic ...
}

async function queryCold(
  triggers: Trigger[],
  cold: ColdStore,
  limit: number,
): Promise<ManifestItem[]> {
  if (!cold.capabilities.semantic) {
    // Fallback: temporal query for recent cold items
    // Implementation depends on ColdStore interface
    return [];
  }
  
  // Semantic search if supported
  const tags = triggers.flatMap(t => t.action.tags ?? []);
  return cold.searchByTags(tags, limit);
}
```

### Manifest Format Update

```typescript
interface ManifestItem {
  id: string;
  type: ContextItemType;
  tags: string[];
  summary: string;
  age: string;
  source?: "warm" | "cold";  // NEW: indicate storage tier
}
```

### Display Update

```xml
<veil-available>
Relevant context found (use recall to load):

- eng_001 [test] "auth test failures from..." (2min ago)
- eng_002 [test] "test helper for mocking..." (5min ago)
- cold_042 [auth] "OAuth2 flow from last week..." (3d ago) [cold]

Budget: 35% used
</veil-available>
```

## Part 5: Cross-Session Episodes

### Episode Linking

When storing episodic context, link to related previous episodes:

```sql
CREATE TABLE IF NOT EXISTS episode_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,         -- "continues", "relates", "supersedes"
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relation)
);

CREATE INDEX idx_episode_source ON episode_links(source_id);
CREATE INDEX idx_episode_target ON episode_links(target_id);
```

### Linking API

```typescript
// In manager.ts

linkEpisodes(
  sourceId: string,
  targetId: string,
  relation: "continues" | "relates" | "supersedes",
): void {
  this.cache.linkEpisodes(sourceId, targetId, relation);
}

getRelatedEpisodes(itemId: string): Array<{
  item: ContextItem;
  relation: string;
}> {
  return this.cache.getRelatedEpisodes(itemId);
}
```

### "What did I try last time?" Query

New tool for cross-session retrieval:

```typescript
// In tools.ts

{
  name: "veil_history",
  description: "Search past sessions for related context",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for" },
      days: { type: "number", description: "How far back to search", default: 7 },
    },
    required: ["query"],
  },
}

async function executeVeilHistory(
  params: { query: string; days?: number },
  ctx: { manager: ContextManager },
): Promise<ToolResult> {
  const since = Date.now() - (params.days ?? 7) * 24 * 60 * 60 * 1000;
  
  // Search cold storage
  const results = await ctx.manager.searchHistory(params.query, since);
  
  if (results.length === 0) {
    return { content: "No related context found in recent sessions." };
  }
  
  const formatted = results.map(r => 
    `- ${r.id} [${r.type}] "${r.summary}" (${r.sessionDate})`
  ).join("\n");
  
  return { content: `Found ${results.length} related items:\n\n${formatted}` };
}
```

## Testing

1. **Hydration logging**: Verify events are recorded when agent hydrates manifest items
2. **Pattern analysis**: Test keyword extraction from message sets
3. **Trigger generation**: Verify learned triggers have correct regex and lower priority
4. **Persistence**: Triggers survive harness restart
5. **Cold queries**: Manifest includes cold items when budget allows
6. **Episode links**: Related episodes are retrievable

## Success Criteria

- Hydration events logged with < 1ms overhead
- Pattern analysis runs in < 100ms for 1000 events
- Learned triggers improve manifest hit rate by 20%+
- Cold queries add < 50ms to manifest generation
- Cross-session queries return results in < 200ms

## Implementation Order

1. **P0**: Hydration logging (foundation for learning)
2. **P1**: Trigger persistence (needed before learning can persist)
3. **P1**: Pattern analysis + trigger generation
4. **P2**: Cold storage queries
5. **P2**: Episode linking + history tool
6. **P3**: File/command triggers, observability

## Deferred

- Hysteresis for budget oscillation (add if observed in practice)
- KG integration beyond episode links (wait for KG maturity)
- Trigger confidence decay over time
