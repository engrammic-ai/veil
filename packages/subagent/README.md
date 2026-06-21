# @veil/subagent

Subagent orchestration with Veil context propagation.

## Features

- **Context Isolation:** Each subagent gets its own hot tier
- **Context Propagation:** Child captures merge to parent on completion
- **Bidirectional IPC:** Parent can supervise; children can escalate
- **Cross-Platform:** Works on Linux, macOS, Windows 10+

## Installation

This package is part of the Veil monorepo and is automatically available when using Veil.

## Usage

```typescript
import { executeSubagentTool, discoverAgents } from '@veil/subagent';

// Execute a single agent
const result = await executeSubagentTool(
  {
    parentDbPath: '/path/to/parent.db',
    parentSessionId: 'session-123',
  },
  {
    agent: 'scout',
    task: 'Find all authentication code',
  },
  process.cwd()
);

console.log(result.output);
```

## Agent Definitions

Create agents in `~/.veil/agents/*.md` (user-level) or `.veil/agents/*.md` (project-level):

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls
model: claude-haiku-4-5
veil:
  inheritWarm: true
  enableVeilTools: false
---

You are a scout agent. Your job is to quickly explore the codebase
and return relevant findings.
```

## Modes

### Single Mode
```typescript
{ agent: 'scout', task: 'find auth code' }
```

### Parallel Mode
```typescript
{ tasks: [
  { agent: 'scout', task: 'find models' },
  { agent: 'scout', task: 'find controllers' },
]}
```
Max 8 tasks, 4 concurrent.

### Chain Mode
```typescript
{ chain: [
  { agent: 'scout', task: 'find the auth system' },
  { agent: 'planner', task: 'plan improvements based on: {previous}' },
]}
```
Each step can reference `{previous}` for the prior output.

## IPC Protocol

Parent and child communicate via Unix domain sockets (named pipes on Windows):

**Parent -> Child:**
- `ping` / `interrupt` / `resume` / `redirect` / `abort` / `respond` / `config`

**Child -> Parent:**
- `pong` / `ready` / `escalate` / `checkpoint` / `progress` / `log` / `complete` / `error`

See `src/types.ts` for full message definitions.

## CLI Flags (Child Mode)

When spawning a subagent, these flags are passed automatically:

```
--veil-parent-db <path>     Parent's warm cache DB
--veil-session-id <id>      Parent session ID
--veil-tag <tag>            Subagent tag prefix
--veil-ipc <path>           IPC socket path
--veil-tools <bool>         Enable veil_* tools (default: true)
```

## License

MIT - See repository root for details.
