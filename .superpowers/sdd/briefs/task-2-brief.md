# Task 2: Add Intent Types to veil-memory (Pinned, Never Evicted)

## Location
Extend existing files in `packages/engrammic/src/`

## Requirements

### 1. Extend ContextItemType (types.ts)
Add "intent" to the existing type:
```typescript
export type ContextItemType = "episodic" | "procedural" | "fact" | "decision" | "intent";
```

### 2. Create SessionIntent Interface (intent/intent-types.ts)
Add to existing intent-types.ts:
```typescript
export interface SessionIntent extends IntentNode {
  // Links session intent to project
  projectIntentId?: string;  // which project intent this serves
  projectPhaseId?: string;   // which phase of project intent
  
  // Session scoping
  sessionId: string;
}
```

### 3. Ensure Pinning in Eviction Logic
In `eviction.ts` (or wherever eviction candidates are selected):
- Intent items (type === "intent") must be excluded from eviction
- This is equivalent to treating them as always pinned

Check existing code for how `pinned: true` items are handled and apply same logic to intent types.

## Constraints
- Do NOT create new files except tests
- Modify existing types.ts and intent-types.ts
- Check eviction.ts for pinning logic and update if needed
- Export SessionIntent from intent/index.ts

## Testing
Add tests to verify:
- Intent items are excluded from eviction candidate selection
- SessionIntent type is correctly exported
