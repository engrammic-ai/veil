# Veil Patches

Local modifications to Pi that haven't been upstreamed.

## Maintaining Patches

When syncing upstream:
1. `git stash` any uncommitted work
2. `git fetch upstream && git merge upstream/main`
3. Resolve conflicts in patched files (listed below)
4. Run tests: `npm run test`
5. If tests fail in patched areas, check if upstream changed the same code

## Current Patches

### 001: Message Dimming (assistant-message.ts)

**Purpose:** Allow extensions to dim messages whose context was evicted.

**Files modified:**
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`

**Changes:**
- Added `ANSI_DIM` and `ANSI_RESET` constants
- Added `_dimmed` property
- Added `setDimmed(boolean)` and `isDimmed()` methods
- Modified `render()` to apply dim styling when `_dimmed` is true

**Conflict likelihood:** LOW - render logic rarely changes

**Usage:**
```typescript
// Get reference to AssistantMessageComponent, then:
component.setDimmed(true);
```

## Future: Upstream Proposals

These patches could be upstreamed as Pi extension API enhancements:

| Patch | Proposed API |
|-------|--------------|
| 001 | `ctx.ui.setMessageStyle(entryId, { dimmed: boolean })` |
