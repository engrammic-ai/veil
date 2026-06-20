# Task 1: Create .veil/intent.json Schema and Read/Write Utils

## Location
`packages/engrammic/src/intent/`

## Requirements

### Types (intent-types.ts)
Create these types per spec:

```typescript
interface IntentNode {
  id: string
  type: "primary" | "sub"
  content: string
  
  // Confidence & provenance
  confidence: "explicit" | "inferred"
  source: "user" | "brainstorm" | "plan" | "agent"
  
  // Lifecycle
  status: "active" | "completed" | "abandoned"
  createdAt: number
  completedAt?: number
  
  // Chain (primary intent refinement)
  supersedes?: string  // previous primary intent id
  
  // Tree (sub-intent hierarchy)  
  parent?: string      // primary intent id this belongs to
  
  // Current pointer (only for sub-intents)
  current?: boolean
}

interface ProjectIntent {
  id: string
  content: string
  status: "active" | "completed" | "paused"
  createdAt: number
  updatedAt: number
  
  // Chain for refinement
  supersedes?: string
  
  // Phases/milestones
  phases?: Array<{
    id: string
    content: string
    status: "completed" | "active" | "pending"
  }>
}

interface ProjectIntentFile {
  current: string | null  // current project intent id
  intents: Record<string, ProjectIntent>
  history: string[]  // superseded intent ids (keep last 10)
}
```

### File Utils (project-intent.ts)
- `loadProjectIntent(projectRoot: string): Promise<ProjectIntentFile | null>` - Load from `.veil/intent.json`, return null if not exists
- `saveProjectIntent(projectRoot: string, data: ProjectIntentFile): Promise<void>` - Write to `.veil/intent.json`, create `.veil/` if needed
- `generateIntentId(): string` - Generate unique ID (use `intent_${nanoid(8)}` pattern)

### Constraints
- Use `node:fs/promises` for file operations
- Handle JSON parse errors gracefully (return null, log warning)
- Prune history to last 10 entries on save
- Export all types and functions from index.ts

## Testing
Create `intent.test.ts` with:
- Load returns null for missing file
- Save creates .veil directory if needed
- Round-trip: save then load returns same data
- History pruning keeps last 10
- generateIntentId returns unique ids
