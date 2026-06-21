# Intent Tracking

Intent tracking keeps the agent aligned with the user's goal throughout a session, preventing drift during long conversations.

## Problem

During extended sessions, agents can lose sight of the original goal:
- Context eviction removes early messages containing the user's intent
- Multi-step tasks cause the agent to focus on subtasks and forget the bigger picture
- Session resumption lacks awareness of what work was in progress

## Solution

The `SessionIntentManager` captures and persists user intent:

```
User: "let's work on adding OAuth support"
       │
       ▼
┌─────────────────────────────────┐
│ SessionIntentManager            │
│  primary: "adding OAuth support"│
│  status: active                 │
│  confidence: inferred           │
└─────────────────────────────────┘
       │
       ▼
  Pinned in context (survives eviction)
  Shown in status bar
  Available via /intent command
```

## Components

### SessionIntentManager (`packages/engrammic/src/intent/session-intent.ts`)

Manages intent lifecycle for a session:

- `createPrimary(content, opts)` - Set the main session goal
- `createSub(content, parentId)` - Add sub-intents for task breakdown
- `getPrimary()` / `getCurrent()` - Query active intents
- `complete(id)` / `abandon(id)` - Mark intent outcomes
- `focus(id)` - Switch current pointer to a different sub-intent

Persists to `.veil/session-intents/{sessionId}.json`.

### Intent Tracking Extension (`packages/coding-agent/src/extensions/builtin/intent-tracking.ts`)

Hooks into the agent lifecycle:

**Detection patterns:**
- "let's work on X" / "let's build X"
- "I want to X" / "I want you to X"
- "can you X" / "please X"
- "we need to X"
- "help me with X"
- "the goal is X"

**Integration points:**
- `session_start` - Load persisted intents
- `before_agent_start` - Detect intent in user message (if no primary exists)
- Status bar - Shows current intent (truncated)

**Commands:**
- `/intent` - Show all tracked intents
- `/intent <goal>` - Explicitly set primary intent

## Intent Types

```typescript
interface SessionIntent {
  id: string;
  type: "primary" | "sub";
  content: string;
  confidence: "explicit" | "inferred";
  source: "user" | "agent";
  status: "active" | "pending" | "completed" | "abandoned";
  parent?: string;      // for sub-intents
  current?: boolean;    // pointer for sub-intent navigation
}
```

## Current Pointer

For task breakdowns, the `current` pointer tracks which sub-intent is active:

```
Primary: "Build authentication system"
  ├─ [done]    Add User model
  ├─ [current] Implement JWT tokens  ← focus here
  └─ [pending] Add login endpoint
```

When `complete(id)` is called on the current sub-intent, the pointer auto-advances to the next pending one.

## Eviction Protection

Intent items are pinned against context eviction (see `manager.ts` eviction exclusions). This ensures the agent always knows what it's working toward, even under memory pressure.

## Conversation Eviction

Intent tracking enables *smart conversation eviction* - pruning old turns while preserving critical context.

### Turn Classification

Every turn gets classified for eviction scoring:

| Type | Evictable? | Example |
|------|------------|---------|
| `intent_declaration` | NEVER | "I want to refactor auth" |
| `decision` | NEVER (until superseded) | "Let's use approach X" |
| `correction` | NEVER | "No, not that way" |
| `exploration` | YES (after conclusion) | "What if we tried..." |
| `action` | YES (after completion) | "Read file X" |
| `status` | YES (after N turns) | "Done with step 1" |

### Classification Modes

**Mode C (loops/autonomous):** Agent calls `veil_turn_meta` tool — ~99% compliance via schema enforcement

**Mode B (interactive):** Agent emits `<turn-meta>` block, heuristic fallback if missing

### Reference Detection

References inferred via embedding similarity (no agent cooperation needed):
- 12-turn protected window (never evicted)
- Cosine similarity > 0.7 = referenced = lower eviction score

### Components

| File | Purpose |
|------|---------|
| `turn-classifier.ts` | Parse `<turn-meta>` + heuristic fallback |
| `conversation-archive.ts` | SQLite storage for archived turns |
| `reference-detector.ts` | Embedding similarity for references |
| `turn-eviction.ts` | Eviction scoring with protected window |
| `turn-stub.ts` | Generate stubs for evicted turns |
| `eviction-feedback.ts` | Detect eviction mistakes |
| `commands/history.ts` | `/history` command for archive search |

### Storage

Separate `conversation_archive` table from veil-memory (different retention policies):
- Active session: keep all turns
- Evicted: archive for 30 days
- Decisions/corrections: keep indefinitely

### Commands

- `/history <query>` - Search conversation archive (distinct from `veil_history` for episodic memory)

## Future Work

- **Agent-inferred sub-intents**: Let the agent propose task breakdowns
- **Intent drift detection**: Alert when agent responses diverge from stated intent
- **Cross-session continuity**: Surface intents from prior sessions on resume
- **Project-level intents**: Shared goals across sessions (see `project-intent.ts`)
