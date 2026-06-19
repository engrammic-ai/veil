# /context Command Design

**Status**: Approved  
**Date**: 2026-06-19  
**Supersedes**: `context/archive/SPEC-slash-commands.md` (partial)

---

## Summary

Add `/context` (alias `/ctx`) as a **viewing-only** command for observing the autonomic context system. No mutation operations — those stay as agent tools (`veil_pin`, `veil_forget`, etc.).

Philosophy: Veil is autonomic (self-running, like breathing). The `/context` command is the observability escape hatch — normally you don't think about what Veil is doing, but when you want to understand why something was forgotten or what's loaded, you can observe.

---

## Commands

### /context (alias: /ctx)

Show current context window state.

```
Context Window
──────────────

Hot (loaded):     3 items, 2.1k tokens
  +- src/auth.ts...       1.2k   explicit [pin]
  +- grep:validateToken    400   auto
  +- git diff HEAD~1       500   auto

Warm (cached):    47 items
Cold (storage):   234 items

Budget: 2.1k / 8k (26%)  ========............
Threshold: 80% (adaptive)
```

### /context search \<query\>

Search across all tiers.

```
Results for "auth"
──────────────────
[hot]  abc123  file:src/auth.ts           1.2k tok
[warm] def456  fact:"API uses OAuth2"       45 tok
[cold] ghi789  episode:auth flow discuss   200 tok

3 results (1 hot, 1 warm, 1 cold)
```

Search matches substring on content + exact match on tags. Returns up to 10 results ranked by tier priority (hot > warm > cold) then relevance.

---

## Architecture

### File Changes

```
packages/engrammic/src/commands/context.ts  (exists, update)
  - renderContextCommand() — update to use Pi theme helpers
  - renderContextSearch(query) — NEW

packages/engrammic/src/harness.ts (extend)
  - search(query, limit) — NEW

packages/engrammic/src/cache.ts (extend)
  - searchItems(query, limit) — NEW SQL search

packages/coding-agent/src/modes/interactive/interactive-mode.ts
  - Add /context and /ctx handling
  - handleContextCommand(args?: string)

packages/coding-agent/src/core/slash-commands.ts
  - Add { name: "context", description: "Show context window state" }
  - Add { name: "ctx", description: "Alias for /context" }
```

### Types

```typescript
interface SearchResult {
  id: string;
  tier: "hot" | "warm" | "cold";
  type: ContextItemType;
  summary: string;      // first 40 chars
  tokens: number;
  score: number;        // 0-1 relevance
  tags: string[];
}
```

### Search Implementation

```typescript
// ContextCache (warm tier)
searchItems(query: string, limit: number): ContextItem[] {
  // SQL: SELECT ... WHERE content LIKE ? OR tags LIKE ?
  // ORDER BY last_access DESC LIMIT ?
}

// VeilHarness
search(query: string, limit = 10): SearchResult[] {
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();
  
  // 1. Hot (loaded) - in-memory filter
  for (const item of this.manager.getWindow().items) {
    if (matches(item, lowerQuery)) {
      results.push({ ...format(item), tier: "hot", score: 1.0 });
    }
  }
  
  // 2. Warm - SQL search (dedupe against hot)
  const warm = this.manager.getCache().searchItems(query, limit);
  for (const item of warm) {
    if (!results.find(r => r.id === item.id)) {
      results.push({ ...format(item), tier: "warm", score: 0.8 });
    }
  }
  
  // 3. Cold - skip for MVP (semantic search future)
  
  return results.slice(0, limit);
}
```

### UX Integration

Follow Pi's TUI patterns:
- `theme.bold()` for headers
- `theme.fg("dim", "Label:")` for labels
- `Text` component with padding
- `Spacer(1)` between sections
- Check `this.session.veilHarness` before access, show warning if not active

---

## Testing

### Unit Tests

```
packages/engrammic/src/commands/context.test.ts
  - renderContextCommand returns expected format
  - renderContextSearch finds items across tiers
  - Empty results handled gracefully

packages/engrammic/src/harness.test.ts
  - search() returns hot items first
  - search() dedupes across tiers
  - search() respects limit

packages/engrammic/src/cache.test.ts
  - searchItems() SQL LIKE works
  - searchItems() returns by recency
```

### Manual Verification

- [ ] `/context` shows output when harness active
- [ ] `/context` shows warning when harness not active
- [ ] `/context search auth` finds matching items
- [ ] `/ctx` alias works
- [ ] Empty search returns "No results"

---

## Future (not in scope)

- **Interactive overlay (Approach C)**: TUI overlay with browsing, inline search, expand details. Add to roadmap under CLI & UX.
- **Cold semantic search**: Embedding-based similarity search in cold tier when embedder is available.
- **Mutation commands**: `/context pin`, `/context forget`, etc. — keep as agent tools for now.

---

## Implementation Order

1. Add `searchItems()` to ContextCache with tests
2. Add `search()` to VeilHarness with tests
3. Update `renderContextCommand()` to use theme helpers
4. Add `renderContextSearch()` with tests
5. Wire up in interactive-mode.ts
6. Add to BUILTIN_SLASH_COMMANDS
7. Manual verification
