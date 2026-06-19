# Statusbar Widget System Spec

> Status: Draft  
> Author: Claude + User  
> Date: 2026-06-19

## Overview

A modular, configurable statusbar for Veil that displays session info on the left and the memory cat companion on the right. Users can customize via presets or full widget configuration.

## Design Goals

1. **Modular** — each piece of info is a self-contained widget
2. **Configurable** — presets for quick setup, full config for power users
3. **Extensible** — internal widgets now, custom widgets via extensions on roadmap
4. **Responsive** — adapts to terminal width, compact mode for small displays
5. **Maintainable** — minimal coupling to Pi internals, survives upstream rebases

---

## Implementation Approach

### Use Pi Extension API (not internal modifications)

Pi provides stable extension APIs that we should leverage:

| API | Purpose | Our usage |
|-----|---------|-----------|
| `ctx.ui.setFooter(factory)` | Replace footer component | Main statusbar |
| `ctx.ui.setStatus(key, text)` | Status text in footer | Fallback/simple mode |
| `ctx.ui.setWidget(key, lines, placement)` | Widget above/below editor | Alternative cat placement |
| `footerData.getGitBranch()` | Current git branch | Project widget |
| `footerData.onBranchChange()` | Branch change callback | Auto-refresh |

### Why extension-based?

1. **Fork maintenance** — Pi internals may change on rebase; extension API is stable
2. **Clean separation** — Veil-specific code lives in Veil, not patched into Pi
3. **Easier testing** — Can test statusbar in isolation
4. **User customization** — Users can disable/replace if needed

### Coupling analysis

| Approach | Coupling | Rebase risk | Maintenance |
|----------|----------|-------------|-------------|
| Modify `FooterComponent` | High | High — merges conflict | Hard |
| Modify `interactive-mode.ts` | High | High — 5k+ line file | Hard |
| Extension via `setFooter()` | Low | Low — API stable | Easy |
| Standalone TUI component | None | None | Easiest but limited |

**Decision:** Extension-based via `setFooter()` API

## Layout

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ ~/project (main) +12 -3                           ┌──────────────────────────────┐  │
│ Context: [████████████░░░░░░░░] 84k/200k (42%)    │   /\_/\      remembered      │  │
│ Cached: 7.3M  ↑960  ↓48.2k                        │  ( ^.^ )    "API uses        │  │
│ opus • high effort                                │   > + <      OAuth2 + PKCE"  │  │
│ mode: auto-accept                                 └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Left side (5 lines):**
| Line | Content | Notes |
|------|---------|-------|
| 1 | `~/project (main) +12 -3` | path, branch, git diff stats |
| 2 | `Context: [████░░░] 84k/200k (42%)` | visual progress bar |
| 3 | `Cached: 7.3M  ↑960  ↓48.2k` | cache + in/out tokens |
| 4 | `opus • high effort` | model + thinking/effort level |
| 5 | `mode: auto-accept` | permission mode (always shown) |

**Right side:**
- Cat box (~30 chars wide)
- Shows memory state + detail text

---

## Widget Interface

```typescript
interface StatusBarWidget {
  /** Unique identifier, matches config keys */
  id: string;
  
  /** Human-readable name for UI/docs */
  name: string;
  
  /** Which side it prefers (can be overridden) */
  defaultSide: "left" | "right";
  
  /** How many lines this widget needs (1-5) */
  lines: number;
  
  /** Config schema for validation (optional) */
  configSchema?: JSONSchema;
  
  /** Initialize with config + dependencies */
  init(config: Record<string, unknown>, ctx: WidgetContext): void;
  
  /** Render to string array (one per line) */
  render(width: number): string[];
  
  /** Called on state changes (memory events, session updates, etc.) */
  update(event: WidgetEvent): void;
  
  /** Cleanup */
  dispose?(): void;
}
```

---

## Widget Context

```typescript
interface WidgetContext {
  session: AgentSession;
  veilHarness?: VeilHarness;
  footerData: ReadonlyFooterDataProvider;
  theme: Theme;
  terminal: { width: number; height: number };
}
```

---

## Widget Events

```typescript
type WidgetEvent =
  | { type: "memory"; state: CatState; detail?: string }
  | { type: "session"; usage: TokenUsage }
  | { type: "git"; branch: string; diff?: { added: number; removed: number } }
  | { type: "resize"; width: number; height: number }
  | { type: "mode"; mode: string };
```

---

## Built-in Widgets

| ID | Lines | Default Side | Description |
|----|-------|--------------|-------------|
| `project` | 1 | left | `~/path (branch) +12 -3` |
| `context-bar` | 1 | left | `Context: [████░░░] 84k/200k (42%)` |
| `tokens` | 1 | left | `Cached: 7.3M  ↑960  ↓48.2k` |
| `model` | 1 | left | `opus • high effort` |
| `mode` | 1 | left | `mode: auto-accept` (always shown) |
| `cat` | 5 | right | The memory cat box |
| `context-percent` | 1 | left | `42% of 200k` (minimal alternative) |
| `cost` | 1 | left | `$0.123` |

---

## Layout Engine

```typescript
interface StatusBarLayout {
  /** Load config and instantiate widgets */
  load(config: StatusBarConfig, ctx: WidgetContext): void;
  
  /** Render full statusbar (left + right combined) */
  render(width: number): string[];
  
  /** Forward events to all widgets */
  emit(event: WidgetEvent): void;
  
  /** Get active widget by ID */
  getWidget(id: string): StatusBarWidget | undefined;
}
```

**Render logic:**
1. Calculate right-side width from right widgets
2. Remaining width goes to left side
3. Render each side independently
4. Combine line-by-line: `leftLine + padding + rightLine`
5. Pad to total `lines = max(leftLines, rightLines)`

---

## Configuration

### Schema

```typescript
interface StatusBarConfig {
  preset?: "full" | "minimal" | "demo";
  left?: string[];           // widget IDs
  right?: string[];          // widget IDs
  hide?: string[];           // widget IDs to remove
  widgets?: {
    [widgetId: string]: Record<string, unknown>;
  };
}
```

### Example Config

```json
{
  "statusbar": {
    "preset": "full",
    
    "left": ["project", "context-bar", "tokens", "model", "mode"],
    "right": ["cat"],
    
    "hide": ["cost"],
    
    "widgets": {
      "context-bar": { "style": "bar" },
      "tokens": { "showCache": true, "symbols": true },
      "cat": { "compact": false }
    }
  }
}
```

### How Config is Applied

1. `preset` loads a default layout
2. `left`/`right` override the preset's layout if specified
3. `hide` removes specific widgets without rewriting the whole layout
4. `widgets` configures individual widget options

### Presets

| Preset | Left | Right |
|--------|------|-------|
| `full` | project, context-bar, tokens, model, mode | cat |
| `minimal` | model, context-percent | (none) |
| `demo` | project, model | cat |

### Config Location

- Project: `.veil/statusbar.json`
- User: `~/.config/veil/statusbar.json`
- Project overrides user config

### Reload Behavior

Config changes require restart. No hot-reload for now.

---

## File Structure

```
packages/coding-agent/src/extensions/veil-statusbar/
├── index.ts                 # extension entry point (registers on session_start)
├── types.ts                 # interfaces
├── layout.ts                # StatusBarLayout
├── presets.ts               # built-in presets
├── config.ts                # config loading/validation
└── widgets/
    ├── index.ts             # widget registry
    ├── project.ts
    ├── context-bar.ts
    ├── tokens.ts
    ├── model.ts
    ├── mode.ts
    ├── cat.ts
    └── cost.ts
```

### Integration point

```typescript
// packages/coding-agent/src/extensions/veil-statusbar/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function veilStatusbar(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    
    const layout = new StatusBarLayout();
    layout.load(loadConfig(), ctx);
    
    ctx.ui.setFooter((tui, theme, footerData) => ({
      render: (width) => layout.render(width),
      invalidate: () => layout.invalidate(),
      dispose: () => layout.dispose(),
    }));
  });
}
```

### Loading the extension

Option A: Auto-load in Veil's main.ts (always on)
Option B: User loads via `-e` flag (opt-in)
Option C: Config toggle in `.veil/settings.json`

**Recommendation:** Option A for Veil, with kill switch in config

---

## Decisions

| Question | Decision |
|----------|----------|
| Custom widgets via extensions? | Internal for now, custom on roadmap |
| Live reload config? | No, restart required |
| Per-session override via `/statusbar`? | Deferred |

---

## Resolved Questions

| Question | Decision |
|----------|----------|
| Colors | Inherit from Veil/Pi base theme system |
| Diff stats | Use `git diff --stat` |
| Mode line | Always show |

---

## Implementation Order

### Phase 1: Core (MVP for demo)
1. `types.ts` — interfaces
2. `index.ts` — extension entry point with setFooter()
3. `layout.ts` — layout engine (left/right split)
4. `widgets/cat.ts` — cat widget (port from existing cat-status-box.ts)
5. `widgets/project.ts` — path + branch + diff
6. Wire up: load extension in main.ts

### Phase 2: Full widgets
7. `widgets/context-bar.ts` — visual progress bar
8. `widgets/tokens.ts` — cache + in/out stats
9. `widgets/model.ts` — model + effort level
10. `widgets/mode.ts` — permission mode

### Phase 3: Configuration
11. `presets.ts` — preset definitions
12. `config.ts` — config loading from .veil/statusbar.json
13. Widget-specific config options

### Phase 4: Polish
14. Responsive/compact mode
15. Tests
16. Documentation

---

## Fork Maintenance Strategy

### Principles

1. **Minimize Pi patches** — Keep Veil-specific code in separate files/directories
2. **Use stable APIs** — Extension API > internal modifications
3. **Document divergence** — Track what we changed and why
4. **Rebase-friendly structure** — Veil additions in isolated locations

### What we touch in Pi

| File | Change | Risk |
|------|--------|------|
| `main.ts` | Load veil-statusbar extension | Low — single line |
| `package.json` | Version bump, name | Low |
| New directory | `src/extensions/veil-statusbar/` | None — additive |

### What we DON'T touch

- `FooterComponent` — use setFooter() instead
- `interactive-mode.ts` — 5k+ lines, high conflict risk
- TUI internals — use public Component interface

### On Pi rebase

1. `git rebase upstream/main`
2. Conflicts likely in: `main.ts`, `package.json`
3. Conflicts unlikely in: `src/extensions/veil-statusbar/*`
4. After rebase: verify extension API still works (run statusbar)

### Upstream contribution path

If Pi wants our statusbar:
1. Extract widget system to standalone package
2. PR to Pi as optional extension
3. Veil becomes thin wrapper + cat widget

---

## Testing

### Unit tests

- Each widget renders correctly at various widths
- Layout combines left/right correctly
- Config loading/presets work

### Integration tests

- Extension loads on session_start
- Footer renders with all widgets
- Memory events update cat state
- Git branch changes trigger refresh

### Manual testing

```bash
# Test with different presets
echo '{"statusbar":{"preset":"minimal"}}' > .veil/statusbar.json
./veil-test.sh

# Test responsive behavior
# Resize terminal, verify compact mode kicks in
```
