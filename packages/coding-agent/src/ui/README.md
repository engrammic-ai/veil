# Subagent UI

Interactive TUI panel for managing Veil subagents.

## Usage

```typescript
import { SubagentPanel } from './ui';

const panel = new SubagentPanel('parallel');

// Add agents when spawned
panel.addAgent('scout-models', 'Find model files');
panel.addAgent('scout-ctrl', 'Find controllers');

// Wire up IPC events
ipcServer.onMessage((msg, tag) => {
  switch (msg.type) {
    case 'checkpoint':
      panel.onCheckpoint(tag, msg.turn, msg.tokens, msg.lastTool);
      break;
    case 'progress':
      panel.onProgress(tag, msg.message, msg.percent);
      break;
    case 'complete':
      panel.onComplete(tag, msg.result);
      break;
    case 'error':
      panel.onError(tag, msg.message);
      break;
    case 'escalate':
      panel.onEscalate(tag, msg.requestId, msg.question);
      break;
  }
});

// Wire up action callbacks
panel.onKill = (tag) => {
  // Send abort to child process
  ipcServer.send(tag, { type: 'abort' });
};

panel.onPause = (tag) => {
  ipcServer.send(tag, { type: 'interrupt' });
};

panel.onResume = (tag) => {
  ipcServer.send(tag, { type: 'resume' });
};

panel.onEscalationAnswer = (tag, requestId, answer) => {
  ipcServer.send(tag, { type: 'respond', requestId, answer });
};

// Render
const lines = panel.render(80);
```

## Keyboard Controls

| Key | Action |
|-----|--------|
| `up/down` | Navigate selection |
| `Enter` | Expand/collapse selected |
| `x` | Kill selected |
| `p` | Pause selected |
| `r` | Resume selected |
| `y/n` | Answer escalation |

## Status Icons

| Icon | Status |
|------|--------|
| `?` | Pending |
| `o` | Running |
| `*` | Complete |
| `X` | Error |
| `=` | Paused |
| `!` | Escalating |

## Modes

- **single**: One subagent at a time
- **parallel**: Multiple subagents running concurrently
- **chain**: Sequential subagents, output flows to next
