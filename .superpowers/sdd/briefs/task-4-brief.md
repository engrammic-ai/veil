# Task 4: Session ID Tracking for Intent Persistence

## Location
Extend `packages/engrammic/src/intent/session-intent.ts`

## Requirements

### Add Persistence to SessionIntentManager

Extend the existing SessionIntentManager to persist to disk:

```typescript
interface SessionIntentManagerOptions {
  sessionId: string;
  projectRoot: string;  // where .veil/ lives
}

// Storage location: .veil/session-intents/<sessionId>.json
```

### Methods to Add/Modify

```typescript
class SessionIntentManager {
  constructor(options: SessionIntentManagerOptions);
  
  // Load existing session intents from disk
  static async load(options: SessionIntentManagerOptions): Promise<SessionIntentManager>;
  
  // Save current state to disk (call after mutations)
  async save(): Promise<void>;
  
  // All mutation methods (createPrimary, createSub, complete, abandon, focus, clear)
  // should auto-save after mutation
}
```

### File Format
```json
{
  "sessionId": "session_abc123",
  "intents": {
    "intent_xyz": { /* SessionIntent */ }
  },
  "createdAt": 1234567890,
  "updatedAt": 1234567890
}
```

### Constraints
- Use `node:fs/promises` for file operations
- Create `.veil/session-intents/` directory if needed
- Return empty manager if file doesn't exist (new session)
- Handle JSON parse errors gracefully (return empty manager, log warning)
- Each mutation auto-saves (keep it simple, optimize later if needed)

## Testing
Add to `session-intent.test.ts`:
- load returns empty manager for new session
- save creates directory and file
- round-trip: create intents, save, load returns same state
- mutations auto-save (verify file updated after createSub)
- handles corrupt JSON gracefully
