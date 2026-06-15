# Faded History Display

**Status**: Implemented  
**Date**: 2026-06-14  
**Depends on**: Phase 4 UX (complete), message dimming patch (complete)

## Goal

When context items are evicted, dim the corresponding messages in the TUI so users can see what the agent no longer "remembers".

## Current State

We have:
- `AssistantMessageComponent.setDimmed(boolean)` - applies ANSI dim styling
- `VeilHarness.onEviction` callback - fires when items are evicted
- `ContextItem` with `id`, `contentHash`, `tags`, etc.

We don't have:
- Link between ContextItem and session entry ID
- Way for extensions to access rendered message components
- Registry of components by entry ID

## Design Options

### Option A: Entry ID Tracking (Recommended)

Add `sourceEntryId` to ContextItem when auto-capturing tool results.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│ Tool Result │ ──> │ Capture Rule │ ──> │ ContextItem         │
│ (entryId)   │     │              │     │ sourceEntryId: "x"  │
└─────────────┘     └──────────────┘     └─────────────────────┘
                                                   │
                                                   v
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│ Eviction    │ ──> │ Extension    │ ──> │ setMessageDimmed    │
│ (entryIds)  │     │ Handler      │     │ ("x", true)         │
└─────────────┘     └──────────────┘     └─────────────────────┘
```

**Pros:** Clean data flow, extension API is simple  
**Cons:** Requires modifying ContextItem type, capture needs entry ID

### Option B: Content Hash Matching

Match evicted items to messages by content hash.

**Pros:** No schema changes  
**Cons:** Fragile (truncation, formatting), expensive to compute

### Option C: Timestamp Proximity

Match by timestamp - evicted item's createdAt ~= message timestamp.

**Pros:** Simple  
**Cons:** Unreliable, multiple items per turn

## Recommended: Option A

### Changes Required

#### 1. Types (packages/engrammic/src/types.ts)

```typescript
interface ContextItem {
  // ... existing fields
  sourceEntryId?: string;  // NEW: links to Pi session entry
}
```

#### 2. Capture (packages/engrammic/src/capture.ts)

Modify `autoCapture()` to accept and store entry ID:

```typescript
autoCapture(
  toolName: string, 
  args: unknown, 
  content: Content[], 
  entryId?: string  // NEW
): void
```

#### 3. Harness Event Subscription (packages/engrammic/src/harness.ts)

The `tool_result` event from Pi includes entry context. Extract entry ID:

```typescript
// Current
agentHarness.on("tool_result", (event) => {
  this.autoCapture(event.toolName, event.input, event.content);
});

// New
agentHarness.on("tool_result", (event) => {
  this.autoCapture(event.toolName, event.input, event.content, event.entryId);
});
```

**Question:** Does Pi's tool_result event include entryId? Need to verify.

#### 4. Extension UI Hook (Pi patch)

Add to ExtensionUIContext:

```typescript
interface ExtensionUIContext {
  // ... existing
  
  /** Dim/undim a message by its session entry ID. */
  setMessageDimmed(entryId: string, dimmed: boolean): void;
}
```

#### 5. Interactive Mode Component Registry (Pi patch)

Track message components by entry ID:

```typescript
// In interactive-mode.ts
private messageComponents = new Map<string, AssistantMessageComponent>();

// When creating component:
case "assistant": {
  const component = new AssistantMessageComponent(...);
  if (entryId) {
    this.messageComponents.set(entryId, component);
  }
  this.chatContainer.addChild(component);
  break;
}

// Expose via UI context:
setMessageDimmed(entryId: string, dimmed: boolean): void {
  const component = this.messageComponents.get(entryId);
  if (component) {
    component.setDimmed(dimmed);
    component.invalidate();
  }
}
```

#### 6. Veil Extension (packages/engrammic/src/extension.ts)

Wire eviction to dimming:

```typescript
export function createVeilExtension(harness: VeilHarness) {
  return function(pi: ExtensionAPI) {
    // ... existing status bar code
    
    // Subscribe to eviction
    harness.onEviction((evicted) => {
      for (const candidate of evicted) {
        if (candidate.item.sourceEntryId) {
          // Need access to ctx here - may need different event
        }
      }
    });
  };
}
```

**Problem:** `onEviction` callback doesn't have access to `ctx`. Need to rethink.

### Alternative: Eviction Event

Instead of callback, emit an event that the extension handles:

```typescript
// In extension
pi.on("turn_end", async (_event, ctx) => {
  const evictedIds = harness.getAndClearEvictedEntryIds();
  for (const entryId of evictedIds) {
    ctx.ui.setMessageDimmed(entryId, true);
  }
});
```

Harness tracks evicted entry IDs, extension reads them on turn_end when it has ctx.

## Implementation Tasks

1. **Verify Pi event schema** - Does tool_result include entryId?
2. **Add sourceEntryId to ContextItem** - types.ts change
3. **Update capture to store entryId** - capture.ts, harness.ts
4. **Add evicted entry tracking** - harness tracks Set<string>
5. **Pi patch: component registry** - interactive-mode.ts
6. **Pi patch: setMessageDimmed** - extension types + interactive-mode
7. **Wire extension** - extension.ts reads evicted IDs on turn_end
8. **Tests** - unit tests for each component

## Open Questions

1. ~~Does Pi's `tool_result` event include entry ID?~~ **NO** - only has `toolCallId`
2. Should we dim user messages too, or just assistant messages?
3. What about tool result displays - dim those too?
4. Should dimmed messages have a visual indicator beyond opacity (e.g., "[evicted]" badge)?

## Finding: Entry ID Gap

Pi's `tool_result` event has `toolCallId` but not session `entryId`. Options:

**A. Pi patch: Add entryId to tool_result event**
- Modify event emission in agent-harness or extension-runner
- Clean solution, requires understanding Pi's event flow

**B. Map toolCallId to entryId**
- Tool results become session entries - there may be a mapping
- Need to trace: where does assistant message + tool calls become session entries?

**C. Use toolCallId as identifier**
- Skip entryId entirely, use toolCallId for both capture and component lookup
- Simpler but may not align with how components are tracked

Recommend investigating (B) first - there's likely already a mapping we can use.

## Finding: Render Flow Gap

Traced the render flow:
```
SessionManager.getContext() 
  → SessionContext { messages: AgentMessage[] }  // NO entry IDs
    → renderSessionContext() 
      → addMessageToChat()
        → new AssistantMessageComponent(message)  // NO entry ID passed
```

The entry IDs exist in `SessionEntry` but are stripped when building `SessionContext`.

**Fix options:**

**A. Pass entry IDs through SessionContext** (invasive)
- Change `SessionContext.messages` to include entry metadata
- Affects many files, high conflict risk with upstream

**B. Build separate entryId→component map during render** (moderate)  
- In `renderSessionContext()`, track which component was created for each message
- Use message index or toolCallId as key
- Pi patch: ~20 lines in interactive-mode.ts

**C. Use toolCallId as the key everywhere** (simplest)
- ContextItem stores `toolCallId` instead of `entryId`
- Components already trackable by toolCallId (tool executions)
- Limitation: only works for tool results, not user/assistant text

**Recommendation:** Option B - build a parallel map during render.

## Files to Modify

| File | Change | Type |
|------|--------|------|
| `packages/engrammic/src/types.ts` | Add sourceEntryId | Veil |
| `packages/engrammic/src/capture.ts` | Accept/store entryId | Veil |
| `packages/engrammic/src/harness.ts` | Track evicted IDs, pass entryId to capture | Veil |
| `packages/engrammic/src/extension.ts` | Call setMessageDimmed on turn_end | Veil |
| `packages/coding-agent/.../interactive-mode.ts` | Component registry, setMessageDimmed | Pi patch |
| `packages/coding-agent/.../extensions/types.ts` | Add setMessageDimmed to UI context | Pi patch |

## Estimated Effort

- Veil changes: ~2 hours
- Pi patches: ~2 hours  
- Testing: ~1 hour
- Total: ~5 hours

## Implementation Notes (2026-06-14)

Used `toolCallId` as the identifier (Option C from Entry ID Gap finding) since:
- `tool_result` events include `toolCallId` 
- Tool execution components are naturally keyed by `toolCallId`
- Avoids invasive changes to Pi's session entry flow

### Changes Made

**Veil Package:**
- `types.ts`: Added `sourceToolCallId?: string` to `ContextItem`
- `cache.ts`: Updated `createItem()` to accept `toolCallId`, added `source_tool_call_id` column with migration
- `harness.ts`: Added `evictedToolCallIds` Set, `getAndClearEvictedToolCallIds()` method, passes `toolCallId` through capture flow
- `extension.ts`: Calls `ctx.ui.setToolCallDimmed()` on `turn_end` for evicted IDs

**Pi Package:**
- `types.ts`: Added `setToolCallDimmed(toolCallId, dimmed)` to `ExtensionUIContext`
- `tool-execution.ts`: Added `_dimmed` flag, `setDimmed()` method, ANSI dim rendering
- `interactive-mode.ts`: Added `toolComponents` registry, `setToolCallDimmed()` implementation
- `rpc-mode.ts`, `runner.ts`: Added no-op `setToolCallDimmed` for non-TUI modes
