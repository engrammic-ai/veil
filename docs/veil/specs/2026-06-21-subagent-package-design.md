# Subagent Package Design Spec

**Date:** 2026-06-21  
**Status:** Draft  
**Depends On:** SPEC-subagent-context.md, packages/engrammic

---

## Overview

A new `packages/subagent` workspace package that provides:
- The `subagent` tool for spawning child Veil agents
- Veil context propagation (fork warm cache, merge on complete)
- Bidirectional IPC for supervisor/escalation patterns
- Cross-platform support (Linux, macOS, Windows)

Replaces the example extension at `packages/coding-agent/examples/extensions/subagent/`.

---

## Goals

1. **Context isolation** — subagents get their own hot tier, can read parent's warm
2. **Context propagation** — captures flow back to parent on completion
3. **Coordination** — parent can supervise; children can escalate
4. **Cross-platform** — works on Linux, macOS, Windows 10+
5. **Full Veil support** — subagents get auto-capture and veil_* tools by default

---

## Package Structure

**Build order:** `tui → ai → veil-embedder → veil-memory → engrammic → subagent → agent → coding-agent`

```
packages/subagent/
├── package.json
├── src/
│   ├── index.ts              # Public exports
│   ├── context.ts            # createSubagentContext, mergeSubagentContext
│   ├── ipc.ts                # Socket server/client, message types
│   ├── tool.ts               # Subagent tool definition
│   ├── spawn.ts              # getVeilInvocation, process management
│   ├── agents.ts             # Agent discovery
│   └── types.ts              # Shared types
└── test/
    ├── context.test.ts
    ├── ipc.test.ts
    └── spawn.test.ts
```

---

## Context Propagation

### API

```typescript
interface SubagentContextOptions {
  inheritWarm?: boolean;      // read parent's warm cache (default: true)
  isolateCaptures?: boolean;  // writes go to child's DB (default: true)
  tag: string;                // e.g. 'scout', 'reviewer'
  enableVeilTools?: boolean;  // register veil_* tools (default: true)
  maxWarmInherit?: number;    // limit inherited items (default: 100)
}

interface SubagentContext {
  sessionId: string;          // parent:tag:timestamp
  parentDbPath: string;       // for --veil-parent-db flag
  childDbPath: string;        // isolated warm cache
  ipcPath: string;            // socket path
  tag: string;
  cleanup(): Promise<void>;   // remove child DB after merge
}

function createSubagentContext(
  parentHarness: VeilHarness,
  options: SubagentContextOptions
): SubagentContext;

function mergeSubagentContext(
  parentHarness: VeilHarness,
  childContext: SubagentContext,
  options?: { transferWeights?: boolean }
): Promise<MergeResult>;
```

### Context Sharing Model

- **Warm cache:** Shared SQLite — child reads parent's DB (read-only), writes to own DB
- **Child DB location:** `${parentDbPath}.children/${sessionId}.db`
- **Hot tier:** Always isolated per agent

### Merge Behavior

On child completion:
1. Read child's warm cache (all items captured during run)
2. Dedupe by content hash (skip exact duplicates in parent)
3. Add provenance metadata to each item
4. Transfer cognitive weights (if child accessed item heavily, boost parent's score)
5. Insert into parent's warm cache with `veil:subagent={tag}` tag
6. Delete child's DB file

**Provenance structure:**
```typescript
{
  source: `subagent:${tag}`,
  parentSession: string,
  childSession: string,
  capturedAt: number,
  status: 'complete' | 'partial',
}
```

---

## Inter-Agent Communication

### Transport

Unix domain sockets with cross-platform path abstraction:

```typescript
function ipcPath(sessionId: string, tag: string): string {
  const name = `veil-ipc-${sessionId}-${tag}`;
  return process.platform === 'win32'
    ? `\\\\?\\pipe\\${name}`
    : `/tmp/${name}.sock`;
}
```

### Protocol

Newline-delimited JSON. All messages include `version: 1`.

**Parent → Child:**
```typescript
type ParentMessage =
  | { version: 1; type: 'ping' }
  | { version: 1; type: 'interrupt' }
  | { version: 1; type: 'resume' }
  | { version: 1; type: 'redirect'; task: string }
  | { version: 1; type: 'abort'; reason?: string }
  | { version: 1; type: 'respond'; requestId: string; answer: string }
  | { version: 1; type: 'config'; key: string; value: unknown }
```

**Child → Parent:**
```typescript
type ChildMessage =
  | { version: 1; type: 'pong' }
  | { version: 1; type: 'ready' }
  | { version: 1; type: 'escalate'; requestId: string; question: string }
  | { version: 1; type: 'checkpoint'; turn: number; tokens: number; timestamp: number; lastTool?: string }
  | { version: 1; type: 'progress'; message: string; percent?: number }
  | { version: 1; type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { version: 1; type: 'complete'; result: string }
  | { version: 1; type: 'error'; message: string }
```

### Escalation Flow

```
Child: { version: 1, type: 'escalate', requestId: 'e1', question: 'Refactor or patch?' }
       ← blocks, waits for response
Parent: (decides, may ask user)
Parent: { version: 1, type: 'respond', requestId: 'e1', answer: 'Patch for now' }
Child: ← injects answer into context, continues
```

### Supervisor Capabilities

- **Interrupt:** Pause child execution
- **Resume:** Continue after interrupt
- **Redirect:** Change child's task mid-run
- **Abort:** Stop child immediately
- **Liveness:** Ping/pong to detect hung children

---

## CLI Integration

### New Flags (child mode)

```
--veil-parent-db <path>     Parent's warm cache (read-only access)
--veil-session-id <id>      Parent session ID for provenance
--veil-tag <tag>            Tag prefix for captures
--veil-ipc <path>           IPC socket path
--veil-tools <bool>         Enable veil_* tools (default: true)
```

When these flags are present, CLI initializes in **child mode**:
- Connects to IPC socket, sends `ready`
- Opens parent DB read-only for warm lookups
- Creates own DB for captures
- Tags all captures with `veil:subagent={tag}`, `veil:parent={sessionId}`
- Runs eviction/scoring independently
- Sends `complete` or `error` on exit

### Process Invocation

```typescript
function getVeilInvocation(ctx: SubagentContext, agent: AgentConfig): string[] {
  const args = [
    'veil',
    '--veil-parent-db', ctx.parentDbPath,
    '--veil-session-id', ctx.sessionId,
    '--veil-tag', ctx.tag,
    '--veil-ipc', ctx.ipcPath,
    '--mode', 'json',
    '--no-session',
  ];
  
  if (agent.model) args.push('--model', agent.model);
  if (agent.tools?.length) args.push('--tools', agent.tools.join(','));
  if (agent.veil?.enableVeilTools === false) args.push('--veil-tools', 'false');
  
  return args;
}
```

---

## Subagent Tool

### Modes

Same as existing extension:
- **Single:** `{ agent, task }`
- **Parallel:** `{ tasks: [...] }` (max 8, 4 concurrent)
- **Chain:** `{ chain: [...] }` with `{previous}` placeholder

### Lifecycle

```
1. Parent calls createSubagentContext(options)
2. Parent creates IPC socket
3. Spawn veil process with context flags
4. Child connects, sends 'ready'
5. Child runs, streams checkpoint/progress
6. Child can escalate, parent responds
7. Child completes, sends 'complete'
8. Parent calls mergeSubagentContext()
9. Child DB cleaned up, socket closed
```

### Error Handling

- **Child crash:** Partial captures merged with `status: 'partial'`
- **Escalation timeout:** Parent can configure timeout, abort if exceeded
- **IPC disconnect:** Treat as crash, merge what's available

---

## Agent Discovery

### Locations

- `~/.veil/agents/*.md` — user-level (always loaded)
- `.veil/agents/*.md` — project-level (opt-in via `agentScope: 'both'`)

### Agent Definition Format

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
veil:
  inheritWarm: true
  enableVeilTools: false
---

System prompt here...
```

The `veil:` block is optional; defaults apply if omitted.

---

## Tool Registration

In `packages/coding-agent/src/main.ts`:

```typescript
import { registerSubagentTool } from '@veil/subagent';

registerSubagentTool(session, {
  veilHarness: harness,
  agentDirs: [userAgentDir, projectAgentDir],
  onEscalate: async (question, childTag) => {
    return await ui.prompt(`[${childTag}] ${question}`);
  },
  onCheckpoint: (checkpoint, childTag) => {
    ui.updateSubagentStatus(childTag, checkpoint);
  },
});
```

---

## Success Criteria

1. **Context isolation:** Subagent hot tier never affects parent's hot
2. **Context propagation:** Child captures merge to parent on completion
3. **Provenance:** Full chain tracked from capture to final location
4. **Performance:** Fork creation <10ms, merge <50ms for 50 items
5. **Cross-platform:** Works on Linux, macOS, Windows 10+
6. **Coordination:** Escalation round-trip <100ms local

---

## Migration Path

1. Create `packages/subagent/` with full implementation
2. Add to workspace `package.json` and build order
3. Add CLI flags to `packages/coding-agent`
4. Delete or thin-shim `examples/extensions/subagent/`
5. Update docs

---

## Open Questions

1. **Escalation UI:** How should escalations surface to the user? Inline in TUI? Modal prompt? Configurable?

2. **Timeout defaults:** What's a reasonable default timeout for escalation responses? 60s? Configurable per-agent?

3. **Max nesting depth:** Should we limit subagent → subagent spawning? Spec suggests depth 2.

---

## Related Documents

- [SPEC-subagent-context.md](../../../context/SPEC-subagent-context.md) — Original context propagation spec
- [Roadmap](../../../context/ROADMAP.md) — Project roadmap
