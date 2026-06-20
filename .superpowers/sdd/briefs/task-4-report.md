# Task 4 Report: Session ID Tracking for Intent Persistence

## Status: DONE

## What Was Done

Extended `SessionIntentManager` in `packages/engrammic/src/intent/session-intent.ts` to persist session intents to disk.

### Constructor change
Replaced `constructor(sessionId: string)` with `constructor(options: SessionIntentManagerOptions)` where options includes `sessionId` and `projectRoot`. All existing tests were updated to use the new signature.

### New API
- `static async load(options)` — reads `.veil/session-intents/<sessionId>.json`; returns empty manager on ENOENT; logs warning and returns empty on corrupt JSON
- `async save()` — creates directory if needed, writes PersistedState JSON
- `async clear()` — now async (was sync); clears and saves
- All mutation methods (`createPrimary`, `createSub`, `complete`, `abandon`, `focus`) fire `void this.save()` for auto-save

### File format
```json
{
  "sessionId": "...",
  "intents": { "<id>": { /* SessionIntent */ } },
  "createdAt": 1234567890,
  "updatedAt": 1234567890
}
```

### Exported
`SessionIntentManagerOptions` added to `packages/engrammic/src/intent/index.ts`.

## Tests Added (session-intent.test.ts)
- `beforeEach` now creates a temp dir and passes it as `projectRoot`; `afterEach` cleans up
- `load returns empty manager for new session`
- `save creates directory and file`
- `round-trip: create intents, save, load returns same state`
- `mutations auto-save (file updated after createSub)` — uses 50ms settle delay for fire-and-forget
- `handles corrupt JSON gracefully` — warns to stderr, returns empty manager
- `saved file includes sessionId, createdAt, updatedAt`

## Test Results
29/29 tests pass. Type check clean. Biome check clean.

## Commit
`feat(intent): add persistence to SessionIntentManager` — b9f7eeab
