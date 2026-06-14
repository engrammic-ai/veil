# Phase 4: UX Enhancements

**Status**: Implemented  
**Date**: 2026-06-14  
**Branch**: `feat/engrammic-ux`  
**PR**: #4

## Overview

Add user-facing UX for the engrammic memory system: status bar indicator, enhanced `/context` command, and optional eviction notifications.

This phase focuses on visibility and feedback. No changes to core eviction mechanics.

**Implemented:** Status bar, `/context` command, debug tick, Pi extension factory.  
**Deferred to future:** Faded history display (requires Pi core API changes).

## Components

### 1. Status Bar Indicator

Show context health in the status bar with color-coded dot:

```
veil > Working on auth flow...                    Context: 2.1k/8k [green dot]
```

| Usage | Color | Dot |
|-------|-------|-----|
| < 50% | Green | Healthy |
| 50-70% | Yellow | Moderate |
| 70-85% | Orange | High |
| > 85% | Red | Critical |

**Implementation**: Hook into Pi's `ctx.ui.setStatus()` on `turn_end`.

```typescript
pi.on("turn_end", async (_event, ctx) => {
  const { hotTokens, veilBudget } = ctx.veilHarness.getUsage();
  const percent = (hotTokens / veilBudget) * 100;
  
  const color = percent < 50 ? "success" 
              : percent < 70 ? "warning"
              : percent < 85 ? "accent" 
              : "error";
  
  ctx.ui.setStatus("veil-context", `Context: ${fmt(hotTokens)}/${fmt(veilBudget)} ${dot(color)}`);
});
```

### 2. Faded History Display

Dim messages whose context was evicted, so user sees what the agent no longer "remembers":

```typescript
interface HistoryDisplayConfig {
  fadeEvicted: boolean;       // default: true
  fadeOpacity: number;        // default: 0.5 (CSS opacity or ANSI dim)
  showEvictionMarker: boolean; // default: false ("[evicted]" badge)
}
```

**Implementation**: Track evicted item IDs per message, apply dim styling in TUI render.

### 3. Enhanced /context Command

Upgrade from simple text to formatted box:

```
> /context

+-- Context Window ------------------------------------------+
|                                                            |
|  Hot (loaded):     3 items, 2.1k tokens                   |
|  +- src/auth.ts        1.2k tok  explicit  pinned [pin]   |
|  +- grep:validateToken  400 tok  auto      5 turns ago    |
|  +- git diff HEAD~1     500 tok  auto      2 turns ago    |
|                                                            |
|  Warm (cached):    47 items                                |
|  Cold (storage):   234 items                               |
|                                                            |
|  Budget: 2.1k / 8k (26%)  ====................            |
|  Threshold: 70% (adaptive)                                 |
|                                                            |
+------------------------------------------------------------+
```

Features:
- Box drawing (or simple ASCII if terminal doesn't support)
- Progress bar for budget
- Item list with type, age, pinned status
- Warm/cold counts (cold requires `coldPointers` implementation)

### 4. Eviction Notifications (Optional)

Notify user when items are evicted:

```typescript
interface EvictionNotifyConfig {
  enabled: boolean;           // default: false
  minItems: number;           // notify if >= N items evicted (default: 3)
  verbosity: 'minimal' | 'standard' | 'verbose';
}

// Minimal: "Evicted 3 items"
// Standard: "Evicted 3 items (auth.ts, grep results, git diff)"  
// Verbose: "Evicted 3 items to free 1.2k tokens: ..."
```

**Implementation**: After `checkEviction()` returns, optionally call `ctx.ui.notify()`.

### 5. Tick Reminder (Debug Mode)

Show tick count in debug mode for development:

```typescript
interface TickDisplayConfig {
  showInUI: boolean;          // default: false
  debugMode: boolean;         // show when --debug flag
}
```

## Config Additions

```typescript
interface ContextManagerConfig {
  // ... existing fields

  // UX
  statusBarEnabled: boolean;     // default: true
  fadeEvicted: boolean;          // default: true
  fadeOpacity: number;           // default: 0.5
  showEvictionMarker: boolean;   // default: false
  evictionNotify: EvictionNotifyConfig;
  tickDebugDisplay: boolean;     // default: false
}
```

## File Changes

| File | Change |
|------|--------|
| `types.ts` | Add UX config fields |
| `harness.ts` | Add `getUsage()` method, status bar hook |
| `commands/context.ts` | Box drawing, progress bar, item details |
| `manager.ts` | Track evicted items for fading |

## Testing Strategy

| Component | Test Focus |
|-----------|------------|
| Status bar | Color thresholds, format |
| /context | Box rendering, item display |
| Notifications | Verbosity levels, minItems threshold |

## Out of Scope

- Cold storage count (requires cold store query, defer to Phase 5)
- Custom themes
- Keyboard shortcuts for context commands

## Dependencies

- Pi TUI primitives (`ctx.ui.setStatus`, `ctx.ui.notify`, theme system)
- Existing harness and manager APIs

## Implementation Notes

### Completed (2026-06-14)

All core components implemented (181 tests passing):

| Component | Status | Notes |
|-----------|--------|-------|
| `ux.ts` | Done | getHealthColor, formatProgressBar, formatBox, formatStatusBar, formatEvictionNotification |
| `types.ts` | Done | EvictionNotifyConfig, statusBarEnabled, fadeEvicted |
| `harness.ts` | Done | getUsage() method |
| `commands/context.ts` | Done | Box format with progress bar |
| `index.ts` | Done | All UX exports |
| `extension.ts` | Done | Pi extension factory with status bar + debug tick |

### Review Findings Addressed

- Fixed percent calculation: `formatStatusBar()` now uses `available = max - reserve` consistent with `getUsage()`
- Added test for formatBox edge case (oversized title)

### TUI Integration Complete (2026-06-14)

| Feature | Status | Notes |
|---------|--------|-------|
| Status bar hook | Done | `createVeilExtension()` subscribes to `turn_end`, calls `ctx.ui.setStatus()` |
| Debug tick display | Done | `--debug-tick` flag shows turn counter in status bar |
| Extension export | Done | `createVeilExtension` exported from index.ts |

Usage:
```typescript
import { createVeilExtension, VeilHarness } from "@engrammic/veil";
const harness = new VeilHarness({ ... });
// In pi config:
extensions: [createVeilExtension(harness)]
```

### Future: Requires Pi Core Changes

These features need Pi extension API enhancements that don't exist yet:

| Feature | Blocker | Proposed Pi API |
|---------|---------|-----------------|
| Faded history (`fadeOpacity`) | No hook to modify existing message rendering | `pi.wrapMessageRenderer(role, wrapper)` or message metadata |
| Eviction marker (`showEvictionMarker`) | Same - can't annotate user/assistant messages | Message metadata visible to renderers |

**Workaround implemented:** Eviction feedback shown via status bar (`ctx.ui.setStatus`) instead of fading messages. This is simpler and doesn't require Pi changes.
