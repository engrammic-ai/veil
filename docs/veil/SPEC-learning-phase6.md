# Learning & Cross-Session Episodes (Phase 6)

**Status**: Implemented  
**Date**: 2026-06-15  
**Implemented**: 2026-06-15  
**Depends on**: Phase 5 Anticipatory Loading  
**Package**: `packages/engrammic`

## Goal

Learn from agent behavior to improve anticipatory loading over time, and enable cross-session episode retrieval.

## Scope

Phase 6 addresses items deferred from Phase 5:

| Feature | Priority | Status | Description |
|---------|----------|--------|-------------|
| Hydration learning | P0 | Done | Track which manifest items get hydrated |
| Trigger generation | P1 | Done | Auto-create triggers from learned patterns |
| Custom trigger persistence | P1 | Done | Save user-defined triggers to SQLite |
| Cold storage queries | P2 | Done | Include cold items in manifest |
| Cross-session episodes | P2 | Done | "What did I try last time?" queries |
| File/command triggers | P3 | Deferred | Trigger on paths or shell commands |
| Observability events | P3 | Deferred | SQLite events for debugging |

## Dependencies

Existing interfaces this spec relies on:

| Interface | Location | Used For |
|-----------|----------|----------|
| `manifestItemIds` | `harness.ts` | Track items shown in manifest |
| `wasInManifest(id)` | `harness.ts` | Check if item was in last manifest |
| `executeVeilTool` | `tools.ts` | Tool execution with callbacks |
| `ColdStore.query()` | `cold/interface.ts` | Cold storage queries (optional) |
| `ContextCache` | `cache.ts` | Warm cache + SQLite |

## Type Changes Required

### types.ts - Extend Trigger interface

```typescript
interface Trigger {
  id: string;
  pattern: RegExp;
  negative?: RegExp;
  type: "keyword" | "file" | "command";
  action: { tags?: string[]; type?: ContextItemType };
  priority: number;
  enabled: boolean;
  // NEW: Phase 6 learning fields
  learned?: boolean;       // True if auto-generated
  confidence?: number;     // 0-1 confidence score
}
```

### types.ts - Extend ManifestItem interface

```typescript
interface ManifestItem {
  id: string;
  type: ContextItemType;
  tags: string[];
  summary: string;
  age: string;
  source?: "warm" | "cold";  // NEW: storage tier indicator
}
```

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

## Part 0: Tool Callback Infrastructure

Before hydration learning can work, `executeVeilTool` needs to notify the harness when `veil_recall` executes.

### tools.ts - Add callback to ToolContext

```typescript
export interface ToolContext {
  manager: ContextManager;
  onRecall?: (ids: string[]) => void;  // NEW: callback for hydration tracking
}

async function executeRecall(
  params: { ids?: string[]; tags?: string[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  let items: ContextItem[] = [];

  if (params.ids?.length) {
    items = ctx.manager.load(params.ids);
    // NEW: notify harness of recalled IDs
    ctx.onRecall?.(params.ids);
  } else if (params.tags?.length) {
    const recalled = ctx.manager.recall(params.tags);
    items = ctx.manager.load(recalled.map((i) => i.id));
    // NEW: notify harness of recalled IDs
    ctx.onRecall?.(recalled.map((i) => i.id));
  }

  // ... rest unchanged
}
```

### harness.ts - Pass callback to executeTool

```typescript
async executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  return executeVeilTool(name, params, {
    manager: this.manager,
    onRecall: (ids) => this.onRecall(ids),  // NEW
  });
}
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
CREATE INDEX idx_hydration_session ON hydration_events(session_id);
```

### harness.ts - New instance variables

```typescript
// NEW: Add these to VeilHarness class
private lastManifestTime: number = 0;
private lastManifestTriggers: string[] = [];
private lastUserMessage: string = "";
```

### harness.ts - Update trackManifestItems signature

```typescript
// CHANGE: Add userMessage parameter (currently takes only manifest)
private trackManifestItems(manifest: ContextManifest, userMessage: string): void {
  this.manifestItemIds.clear();
  for (const item of manifest.items) {
    this.manifestItemIds.add(item.id);
  }
  // NEW: Track for hydration learning
  this.lastManifestTime = Date.now();
  this.lastManifestTriggers = manifest.triggers;
  this.lastUserMessage = userMessage;
}
```

### harness.ts - Update processUserMessage to pass userMessage

```typescript
async processUserMessage(message: string): Promise<string | null> {
  // ... existing trigger matching ...

  if (!manifest) return null;

  // CHANGE: Pass message to trackManifestItems
  this.trackManifestItems(manifest, message);

  // ... rest unchanged
}
```

### harness.ts - Hydration callback

```typescript
interface HydrationEvent {
  sessionId: string;
  itemId: string;
  triggerIds: string[];
  userMessage: string;
  hydratedAt: number;
  latencyMs: number;
}

// Called via onRecall callback from tools.ts
private onRecall(ids: string[]): void {
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

### cache.ts - Hydration logging methods

```typescript
logHydration(event: HydrationEvent): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO hydration_events 
    (session_id, item_id, trigger_ids, user_message, hydrated_at, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    event.sessionId,
    event.itemId,
    JSON.stringify(event.triggerIds),
    event.userMessage,
    event.hydratedAt,
    event.latencyMs,
  );
}

getRecentHydrations(limit: number): HydrationEvent[] {
  const rows = this.db.prepare(`
    SELECT * FROM hydration_events 
    ORDER BY hydrated_at DESC LIMIT ?
  `).all(limit);
  
  return rows.map(row => ({
    sessionId: row.session_id,
    itemId: row.item_id,
    triggerIds: JSON.parse(row.trigger_ids),
    userMessage: row.user_message,
    hydratedAt: row.hydrated_at,
    latencyMs: row.latency_ms,
  }));
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

Analyze hydration events to discover new triggers.

**Note**: This is a simple v1 algorithm using word frequency. Future iterations may add stop word filtering, stemming, or TF-IDF scoring.

```typescript
// src/learning.ts

interface LearnedPattern {
  pattern: string;           // Regex pattern string
  tags: string[];            // Tags to query
  confidence: number;        // 0-1 based on hit rate
  sampleSize: number;        // Number of events analyzed
}

/**
 * Analyze hydration events to find keyword -> tag patterns.
 * 
 * Algorithm:
 * 1. Group hydrations by item tags
 * 2. Extract common words from user messages
 * 3. Score by frequency and uniqueness
 * 4. Generate regex patterns for high-confidence matches
 */
export function analyzePatterns(
  events: HydrationEvent[],
  cache: ContextCache,
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
    
    // Validate regex before storing
    const patternStr = topWords.map(w => `\\b${escapeRegex(w)}\\b`).join('|');
    try {
      new RegExp(patternStr, 'i');
    } catch {
      continue; // Skip invalid patterns
    }
    
    // Calculate confidence: how often do these words appear together?
    const regex = new RegExp(patternStr, 'i');
    const matches = messages.filter(m => regex.test(m)).length;
    const confidence = matches / messages.length;
    
    if (confidence >= minConfidence) {
      patterns.push({
        pattern: patternStr,
        tags: [tag],
        confidence,
        sampleSize: messages.length,
      });
    }
  }
  
  return patterns;
}

function countWords(messages: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    const words = msg.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length < 3) continue; // Skip short words
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

function getTopWords(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

### Trigger Generation

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

Run pattern analysis periodically, not on every request.

```typescript
// In harness.ts

interface LearningConfig {
  intervalMs: number;       // How often to run learning
  minHydrations: number;    // Minimum events before learning
}

private readonly learningConfig: LearningConfig = {
  intervalMs: 60 * 60 * 1000,  // 1 hour default, configurable
  minHydrations: 10,
};
private lastLearnTime: number = 0;

async maybeLearn(): Promise<void> {
  const now = Date.now();
  if (now - this.lastLearnTime < this.learningConfig.intervalMs) return;
  
  const events = this.manager.getCache().getRecentHydrations(1000);
  if (events.length < this.learningConfig.minHydrations) return;
  
  this.lastLearnTime = now;
  
  const patterns = analyzePatterns(
    events,
    this.manager.getCache(),
    this.triggers,
  );
  
  for (const pattern of patterns) {
    const trigger = patternToTrigger(pattern, new Set(this.triggers.map(t => t.id)));
    this.triggers.push(trigger);
    this.manager.getCache().persistTrigger(trigger);
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

### cache.ts - Persistence API

```typescript
persistTrigger(trigger: Trigger): void {
  const now = Date.now();
  this.db.prepare(`
    INSERT OR REPLACE INTO custom_triggers
    (id, pattern, negative_pattern, type, action_tags, action_type, 
     priority, enabled, learned, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
  );
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
  this.db.prepare(`DELETE FROM custom_triggers WHERE id = ?`).run(id);
}
```

### harness.ts - Load on startup

```typescript
// In VeilHarness constructor, after manager init:
const customTriggers = this.manager.getCache().loadCustomTriggers();
this.triggers = [...DEFAULT_TRIGGERS, ...customTriggers];
```

## Part 4: Cold Storage Queries

### Using existing ColdStore.query() method

The `ColdStore` interface has an optional `query()` method. Use it instead of inventing `searchByTags()`:

```typescript
// From cold/interface.ts (existing)
interface ColdStore {
  // ... other methods
  query?(text: string, tags: string[], limit: number): Promise<ContextItem[]>;
}
```

### anticipate.ts - Cold storage integration

```typescript
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
  if (cold?.query && budget.percent < 40 && items.length < 10) {
    const tags = triggers.flatMap(t => t.action.tags ?? []);
    const coldItems = await cold.query("", tags, 10 - items.length);
    
    for (const item of coldItems) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push({
        id: item.id,
        type: item.type,
        tags: item.tags,
        summary: item.content.slice(0, 50).replace(/\n/g, " "),
        age: formatRelativeTime(item.lastAccess),
        source: "cold",
      });
    }
  }
  
  // ... rest of existing logic ...
}
```

### Display format

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

### Episode Linking Schema

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

### cache.ts - Episode linking methods

```typescript
linkEpisodes(
  sourceId: string,
  targetId: string,
  relation: "continues" | "relates" | "supersedes",
): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO episode_links (source_id, target_id, relation, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, relation, Date.now());
}

getRelatedEpisodes(itemId: string): Array<{ item: ContextItem; relation: string }> {
  const rows = this.db.prepare(`
    SELECT target_id, relation FROM episode_links WHERE source_id = ?
    UNION
    SELECT source_id, relation FROM episode_links WHERE target_id = ?
  `).all(itemId, itemId);
  
  return rows
    .map(row => {
      const item = this.get(row.target_id ?? row.source_id);
      return item ? { item, relation: row.relation } : null;
    })
    .filter(Boolean) as Array<{ item: ContextItem; relation: string }>;
}
```

### manager.ts - Episode API

```typescript
linkEpisodes(
  sourceId: string,
  targetId: string,
  relation: "continues" | "relates" | "supersedes",
): void {
  this.cache.linkEpisodes(sourceId, targetId, relation);
}

getRelatedEpisodes(itemId: string): Array<{ item: ContextItem; relation: string }> {
  return this.cache.getRelatedEpisodes(itemId);
}

async searchHistory(query: string, since: number): Promise<Array<{
  id: string;
  type: string;
  summary: string;
  sessionDate: string;
}>> {
  // Search cold storage for historical items
  if (!this.cold?.query) return [];
  
  const items = await this.cold.query(query, [], 20);
  return items
    .filter(i => i.createdAt >= since)
    .map(i => ({
      id: i.id,
      type: i.type,
      summary: i.content.slice(0, 50),
      sessionDate: new Date(i.createdAt).toLocaleDateString(),
    }));
}
```

### tools.ts - veil_history tool

```typescript
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
  ctx: ToolContext,
): Promise<ToolResult> {
  const since = Date.now() - (params.days ?? 7) * 24 * 60 * 60 * 1000;
  
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

1. **Tool callback**: Verify `onRecall` is called when `veil_recall` executes
2. **Hydration logging**: Events recorded with correct trigger IDs and latency
3. **Pattern analysis**: Test keyword extraction, regex validation, confidence scoring
4. **Trigger generation**: Learned triggers have lower priority than defaults
5. **Persistence**: Triggers survive harness restart
6. **Cold queries**: Manifest includes cold items when budget < 40%
7. **Episode links**: Bidirectional retrieval works
8. **Edge cases**: Empty hydration history, identical messages, invalid regex patterns

## Success Criteria

- Hydration events logged with < 1ms overhead
- Pattern analysis runs in < 100ms for 1000 events
- Learned triggers improve manifest hit rate by 20%+
- Cold queries add < 50ms to manifest generation
- Cross-session queries return results in < 200ms

## Implementation Order

1. **Pre-P0**: Tool callback infrastructure (Part 0)
2. **P0**: Hydration logging (Part 1)
3. **P1**: Trigger persistence (Part 3 schema + methods)
4. **P1**: Pattern analysis + trigger generation (Part 2)
5. **P2**: Cold storage queries (Part 4)
6. **P2**: Episode linking + history tool (Part 5)
7. **P3**: File/command triggers, observability

## Deferred

- Hysteresis for budget oscillation (add if observed in practice)
- KG integration beyond episode links (wait for KG maturity)
- Trigger confidence decay over time
- Stop word filtering / stemming in pattern analysis
- Episode relation types beyond continues/relates/supersedes
- File/command triggers (P3)
- Observability events (P3)

## Implementation Notes

**PR**: #5 (phase6-learning branch)  
**Tests**: 278 passing across 17 test files

### Key Implementation Decisions

1. **ManifestContext bundling**: Replaced separate temporal state fields with a bundled `ManifestContext` object to prevent stale data issues. Added 5-minute staleness guard.

2. **Regex flag preservation**: Added `pattern_flags` and `negative_pattern_flags` columns to `custom_triggers` table to preserve original regex flags on reload.

3. **created_at preservation**: Used `INSERT ... ON CONFLICT DO UPDATE` instead of `INSERT OR REPLACE` to preserve original creation timestamps on trigger updates.

4. **SQL column aliasing**: Episode links query uses explicit `AS linked_id` alias in UNION for clarity.

5. **Learning algorithm**: Simple v1 using word frequency. Future iterations may add stopwords, stemming, or TF-IDF.

### Schema Additions

- `hydration_events` - tracks manifest item recalls with latency
- `custom_triggers` - persists learned and user-defined triggers  
- `episode_links` - cross-session context relationships

### New APIs

- `veil_history` tool - search past sessions
- `ContextManager.linkEpisodes()` / `getRelatedEpisodes()` / `searchHistory()`
- `VeilHarness.maybeLearn()` - periodic pattern analysis (1hr interval)
