# ColdStore Query Extensions (Phase G.4)

Extends ColdStore interface with wildcard patterns, listing, prefix queries, and entity disambiguation.

## Motivation

Current `query(text, tags, limit)` only supports semantic search. Missing:
- List all items (no semantic filter)
- Glob patterns in tags (`project:veil-*`)
- ID prefix queries (`mem_abc*`)

## Interface Changes

```typescript
// packages/engrammic/src/cold/interface.ts

export interface ColdStoreCapabilities {
  semantic: boolean;
  temporal: boolean;
  provenance: boolean;
  // NEW
  glob: boolean;      // supports glob patterns in tags
  listing: boolean;   // supports list() without semantic query
}

export interface ListOptions {
  /** Glob patterns allowed. Empty = no tag filter. */
  tags?: string[];
  /** Max items to return. Default: 100. */
  limit?: number;
  /** Pagination cursor from previous response. */
  cursor?: string;
  /** Sort order. Default: "recent". */
  sort?: "recent" | "oldest" | "relevance";
  /** Case-insensitive glob matching. Default: false (case-sensitive). */
  ignoreCase?: boolean;
}

export interface ListResult {
  items: ContextItem[];
  /** Pass to next list() call for pagination. Absent = no more pages. */
  nextCursor?: string;
  /** Total count if backend supports it. */
  total?: number;
}

export interface ColdStore {
  // ... existing methods ...

  /**
   * List items without semantic query.
   * Use for browsing, "show all", or glob-filtered listing.
   * Only available if capabilities.listing is true.
   */
  list?(options?: ListOptions): Promise<ListResult>;

  /**
   * Fetch all items whose ID starts with prefix.
   * Useful for bulk operations on related items.
   */
  fetchByPrefix?(prefix: string, limit?: number): Promise<ContextItem[]>;
}
```

## Glob Pattern Syntax

Minimal glob subset (no regex, keeps it simple):

| Pattern | Matches |
|---------|---------|
| `*` | any sequence of chars |
| `?` | any single char |
| `[abc]` | any char in set |
| `[!abc]` | any char NOT in set |

Examples:
- `project:veil-*` → `project:veil-memory`, `project:veil-embedder`
- `type:epi?odic` → `type:episodic`, `type:epiXodic`
- `scope:[gp]*` → `scope:global`, `scope:project`

No `**` (recursive) — tags are flat strings, not paths.

## Implementation

### MockColdStore

Full implementation for testing:

```typescript
list(options: ListOptions = {}): Promise<ListResult> {
  let items = [...this.items.values()];
  
  // Apply tag globs
  if (options.tags?.length) {
    items = items.filter(item => 
      options.tags!.every(pattern => 
        item.tags.some(tag => globMatch(pattern, tag))
      )
    );
  }
  
  // Sort
  items.sort((a, b) => {
    if (options.sort === "oldest") return a.createdAt - b.createdAt;
    return b.lastAccess - a.lastAccess; // "recent" default
  });
  
  // Paginate
  const start = options.cursor ? parseInt(options.cursor, 10) : 0;
  const limit = options.limit ?? 100;
  const page = items.slice(start, start + limit);
  
  return {
    items: page,
    nextCursor: start + limit < items.length ? String(start + limit) : undefined,
    total: items.length,
  };
}

fetchByPrefix(prefix: string, limit = 100): Promise<ContextItem[]> {
  return [...this.items.values()]
    .filter(item => item.id.startsWith(prefix))
    .slice(0, limit);
}
```

### VeilMemoryColdStore

SQLite implementation with GLOB operator:

```typescript
list(options: ListOptions = {}): Promise<ListResult> {
  // SQLite GLOB is case-sensitive, LIKE is case-insensitive (for ASCII)
  const matchOp = options.ignoreCase ? "LIKE" : "GLOB";
  
  let sql = `SELECT * FROM beliefs WHERE tombstoned = 0`;
  const params: unknown[] = [];
  
  if (options.tags?.length) {
    for (const pattern of options.tags) {
      // Convert glob to LIKE syntax if case-insensitive
      const sqlPattern = options.ignoreCase ? globToLike(pattern) : pattern;
      sql += ` AND EXISTS (
        SELECT 1 FROM json_each(tags) 
        WHERE json_each.value ${matchOp} ?
      )`;
      params.push(sqlPattern);
    }
  }
  
  sql += options.sort === "oldest" 
    ? ` ORDER BY created_at ASC` 
    : ` ORDER BY last_access DESC`;
  
  sql += ` LIMIT ? OFFSET ?`;
  params.push(options.limit ?? 100);
  params.push(options.cursor ? parseInt(options.cursor, 10) : 0);
  
  // ... execute and map results
}

// Convert glob syntax to SQL LIKE syntax
function globToLike(glob: string): string {
  return glob
    .replace(/%/g, "\\%")    // escape LIKE special chars
    .replace(/_/g, "\\_")
    .replace(/\*/g, "%")     // * → %
    .replace(/\?/g, "_");    // ? → _
  // Note: [abc] not supported in LIKE, would need regex or manual expansion
}
```

### EngrammicColdStore

Delegates to MCP server. Server must support:

```typescript
// recall tool extended params
{
  query?: string;           // semantic query (optional now)
  tags?: string[];          // glob patterns
  list_mode?: boolean;      // true = skip semantic, just filter+paginate
  cursor?: string;
  limit?: number;
  sort?: "recent" | "oldest" | "relevance";
}
```

If server doesn't support `list_mode`, fall back to `query="*"` with low relevance threshold.

## query="*" Behavior (Star Query)

`query("*")` is a special case: "give me recent items, no semantic filter."

```typescript
async query(text: string, tags: string[], limit: number): Promise<ContextItem[]> {
  if (text === "*") {
    if (this.list) {
      // Use list() with recent sort (default)
      const result = await this.list({ tags, limit, sort: "recent" });
      return result.items;
    }
    // Fallback: semantic search with empty query, rely on recency boost
    return this.semanticQuery("", tags, limit, { boostRecent: true });
  }
  // ... normal semantic search
}
```

### Star Query Use Cases

| Query | Meaning |
|-------|---------|
| `query("*", [], 10)` | 10 most recent items, any tag |
| `query("*", ["project:veil-*"], 20)` | 20 most recent from veil projects |
| `query("*", ["type:fact"], 5)` | 5 most recent facts |

### Recency Ranking

For star queries, items sorted by `lastAccess` descending (most recent first). This surfaces:
- Recently demoted items
- Items fetched/touched recently
- Fresh context the agent might need

Combined with tag globs, this enables queries like "what have I been working on in veil-memory lately?"

## Capability Detection

Adapters declare capabilities at construction:

```typescript
// MockColdStore
readonly capabilities = { semantic: false, temporal: false, provenance: false, glob: true, listing: true };

// VeilMemoryColdStore  
readonly capabilities = { semantic: true, temporal: true, provenance: false, glob: true, listing: true };

// EngrammicColdStore - depends on server version
readonly capabilities = { semantic: true, temporal: true, provenance: true, glob: true, listing: true };
```

## Test Cases

```typescript
describe("ColdStore glob queries", () => {
  test("list with tag glob", async () => {
    await store.demote({ id: "a", tags: ["project:veil-memory"], ... });
    await store.demote({ id: "b", tags: ["project:veil-embedder"], ... });
    await store.demote({ id: "c", tags: ["project:other"], ... });
    
    const result = await store.list({ tags: ["project:veil-*"] });
    expect(result.items.map(i => i.id)).toEqual(["a", "b"]);
  });

  test("fetchByPrefix", async () => {
    await store.demote({ id: "mem_abc_1", ... });
    await store.demote({ id: "mem_abc_2", ... });
    await store.demote({ id: "mem_xyz_1", ... });
    
    const items = await store.fetchByPrefix("mem_abc");
    expect(items.map(i => i.id)).toEqual(["mem_abc_1", "mem_abc_2"]);
  });

  test("query='*' redirects to list", async () => {
    const items = await store.query("*", ["type:fact"], 10);
    // Should return all facts, not semantic search for literal "*"
  });

  test("pagination", async () => {
    // Insert 150 items
    const page1 = await store.list({ limit: 100 });
    expect(page1.items.length).toBe(100);
    expect(page1.nextCursor).toBeDefined();
    
    const page2 = await store.list({ limit: 100, cursor: page1.nextCursor });
    expect(page2.items.length).toBe(50);
    expect(page2.nextCursor).toBeUndefined();
  });
});
```

## Migration

Non-breaking. New methods are optional (`list?`, `fetchByPrefix?`). Existing code continues to work. New capabilities default to false for backwards compat.

## Open Questions

1. **Glob escaping** — what if tag literally contains `*`? Use `\*`? Or just disallow `*` in tag values?
2. **Max limit** — cap at 1000? 10000? Configurable per-adapter?

## Resolved

- **[abc] in ignoreCase mode** — Not supported. If pattern contains `[`, throw with explanation: "Character sets [abc] not supported with ignoreCase=true. Use case-sensitive mode or multiple patterns."

---

## Entity Disambiguation

Imported facts often have name collisions. Two distinct problems:

| Problem | Example | Resolution |
|---------|---------|------------|
| **Deduplication** | 3 "Veil" descriptions from same codebase | Auto-merge (same entity, multiple records) |
| **Disambiguation** | "Engram" consulting firm vs memory engine | Distinct entity refs (different entities, same name) |

### Signals

| Signal | Strength | Notes |
|--------|----------|-------|
| **Context fingerprint** | High | Co-occurring terms: "FSRS, episodic, sqlite" vs "RLHF, action masking" |
| **Source metadata** | Medium | URL, domain, repo — same source ≠ same entity (articles compare things) |
| **Property alignment** | High | "Founded 2016" vs "repo created 2023" → different entities |
| **Name similarity** | Low | "engram" / "engrammic" are different strings but confusable |

### Data Model

```typescript
interface EntityRef {
  /** Stable canonical ID — never use name as key */
  id: string;  // e.g., "engram:ly-wang19", "veil:autonomic-context"
  
  /** Display name */
  canonicalName: string;
  
  /** Alternative names/spellings that resolve to this entity */
  aliases: string[];
  
  /** Top co-occurring terms — primary disambiguation signal */
  fingerprint: string[];
  
  /** Known source URLs/repos for this entity */
  sources: string[];
  
  /** Optional distinguishing properties */
  properties?: Record<string, string>;  // { "founded": "2023", "domain": "memory" }
}

interface ContextItem {
  // ... existing fields ...
  
  /** Resolved entity ref (null = unresolved, needs disambiguation) */
  entityRef?: string;
  
  /** Provisional entity ID before resolution */
  provisionalEntityId?: string;
}
```

### Resolution Flow

```
1. ON IMPORT:
   ├── Extract entity mentions from content
   ├── Generate provisional ID: hash(source_domain, normalized_name)
   ├── Compute context fingerprint: top 10 co-occurring nouns
   └── Store with provisionalEntityId (not resolved yet)

2. ON QUERY/ACCESS:
   ├── Group items by normalized_name
   ├── Within group, compute pairwise fingerprint similarity
   ├── Cluster by similarity:
   │   ├── >0.8 similarity + same domain → auto-merge (dedup)
   │   ├── <0.5 similarity → distinct entities (disambiguation)
   │   └── 0.5-0.8 → surface for human review
   └── Assign entityRef to resolved items

3. ON CONFUSION (user corrects a mistake):
   └── Add to alias table: { "engrammic" -> "engram:ly-wang19" }
```

### Alias Table

For near-string cases (engram/engrammic), maintain manual alias mappings:

```typescript
interface AliasTable {
  /** Maps variant strings to canonical entity IDs */
  aliases: Map<string, string>;
  
  /** Add alias when user corrects a confusion */
  addAlias(variant: string, canonicalId: string): void;
  
  /** Resolve a name to canonical ID (or null if unknown) */
  resolve(name: string): string | null;
}
```

Built incrementally as confusions arise — don't try to auto-resolve short similar strings.

### Interface Extensions

```typescript
export interface ColdStore {
  // ... existing methods ...
  
  /**
   * Resolve entity mentions to canonical refs.
   * Returns unresolved items for human review.
   */
  resolveEntities?(items: ContextItem[]): Promise<{
    resolved: ContextItem[];
    needsReview: Array<{ item: ContextItem; candidates: EntityRef[] }>;
  }>;
  
  /**
   * Register an alias mapping.
   */
  addEntityAlias?(variant: string, canonicalId: string): Promise<void>;
  
  /**
   * Get or create entity ref.
   */
  getEntity?(id: string): Promise<EntityRef | null>;
  createEntity?(entity: Omit<EntityRef, "id">): Promise<EntityRef>;
}
```

### Context Fingerprint Extraction

```typescript
function extractFingerprint(content: string, limit = 10): string[] {
  // Simple approach: extract nouns/noun-phrases, count frequency
  // Filter out stopwords and generic terms
  // Return top N by frequency
  
  const tokens = content.toLowerCase().split(/\W+/);
  const stopwords = new Set(["the", "a", "an", "is", "are", "was", ...]);
  const counts = new Map<string, number>();
  
  for (const token of tokens) {
    if (token.length > 3 && !stopwords.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

function fingerprintSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;  // Jaccard similarity
}
```

### Example

```typescript
// Import: "Veil uses FSRS decay and sqlite-vec for episodic memory"
const item1 = {
  content: "Veil uses FSRS decay and sqlite-vec for episodic memory",
  provisionalEntityId: hash("github.com/engrammic-ai", "veil"),
  fingerprint: ["fsrs", "decay", "sqlite", "episodic", "memory", "veil"],
};

// Import: "Veil performs pre-runtime action masking for LLM safety"
const item2 = {
  content: "Veil performs pre-runtime action masking for LLM safety",
  provisionalEntityId: hash("agentveil.io", "veil"),
  fingerprint: ["action", "masking", "llm", "safety", "runtime", "veil"],
};

// Fingerprint similarity: ~0.14 (only "veil" overlaps)
// Different domains + low similarity → distinct entities
// item1.entityRef = "veil:autonomic-context"
// item2.entityRef = "veil:agentveil-security"
```
