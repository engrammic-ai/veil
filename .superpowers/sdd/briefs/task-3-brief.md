# Task 3: Implement Current Pointer Logic for Sub-Intents

## Location
Create `packages/engrammic/src/intent/session-intent.ts`

## Requirements

### Session Intent Manager
Create a class or set of functions to manage session intents with current pointer logic:

```typescript
interface SessionIntentManager {
  // Core operations
  createPrimary(content: string, opts?: { confidence?: "explicit" | "inferred", source?: IntentNode["source"] }): SessionIntent;
  createSub(content: string, parentId: string, opts?: { status?: "active" | "pending" }): SessionIntent;
  
  // State queries
  getPrimary(): SessionIntent | null;
  getCurrent(): SessionIntent | null;  // current sub-intent
  getSubIntents(parentId: string): SessionIntent[];
  
  // Lifecycle
  complete(id: string): void;  // marks complete, advances current
  abandon(id: string): void;   // marks abandoned
  focus(id: string): void;     // explicitly set current
  
  // Storage
  getAll(): SessionIntent[];
  clear(): void;
}
```

### Current Pointer Rules
1. When `createSub` creates with `status: "active"`, it becomes current (clear `current` from previous)
2. When `complete(id)` is called on current sub-intent:
   - Find first pending sub-intent (by createdAt order)
   - If found, set its status to "active" and `current: true`
   - If none, no current is set
3. `focus(id)` explicitly sets `current: true` on target, clears from others

### In-Memory Storage
Use a simple Map<string, SessionIntent> for now. Session persistence (Task 4) will add file backing.

### Constraints
- Use generateIntentId() from project-intent.ts for IDs
- Export SessionIntentManager from index.ts
- All mutations must maintain current pointer invariant (only one current)

## Testing
Create `session-intent.test.ts` with:
- createPrimary creates with correct defaults
- createSub with active status becomes current
- createSub clears previous current
- complete advances current to next pending
- complete with no pending clears current
- focus sets current explicitly
- abandon does not affect current pointer (unless abandoned was current)
