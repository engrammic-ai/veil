# Veil Extensions

Extensions add tools, commands, and behaviors to Veil. They're TypeScript files loaded at runtime.

## Bundled Extensions

Veil ships with recommended extensions that work out of the box:

| Extension | Description |
|-----------|-------------|
| `todo.ts` | `/todos` command + todo management tool |
| `tools.ts` | `/tools` command to enable/disable tools |
| `preset.ts` | `/preset` for model/thinking/tool presets |
| `handoff.ts` | `/handoff` to transfer context to new session |
| `git-checkpoint.ts` | Git stash checkpoints per turn for safe rollback |
| `confirm-destructive.ts` | Confirm before clear/switch/fork |
| `notify.ts` | Desktop notification when agent finishes |
| `titlebar-spinner.ts` | Spinner in terminal title while working |

## Installing Additional Extensions

```bash
# From npm
veil install npm:pi-web-access

# From git
veil install git:github.com/user/repo

# Local file
veil install ./path/to/extension.ts

# Project-local (stored in .veil/settings.json)
veil install -l ./extension.ts
```

### Recommended: Web Access

For web search and content fetching:

```bash
veil install npm:pi-web-access
```

Provides `web_search` and `fetch_content` tools. Works zero-config via Exa MCP, or add API keys to `~/.veil/web-search.json` for Perplexity/Gemini.

## Extension Load Order

Extensions load in this order (last wins on conflicts):

1. **Bundled** — shipped with Veil (lowest priority)
2. **Project** — `.veil/extensions/` in current directory
3. **User** — `~/.veil/extensions/` (highest priority)

If you install `todo.ts` to `~/.veil/extensions/`, it shadows the bundled one.

## Managing Extensions

### List installed

```bash
veil list
```

### Remove

```bash
veil remove npm:pi-web-access
```

### Update all

```bash
veil update
```

## Customizing Bundled Extensions

To modify a bundled extension without losing changes on Veil updates:

```bash
# 1. Find bundled extensions path
veil which bundled

# 2. Copy to your extensions directory
cp $(veil which bundled)/notify.ts ~/.veil/extensions/

# 3. Edit your copy
$EDITOR ~/.veil/extensions/notify.ts
```

Your copy takes precedence. You now own updates for that extension.

## Disabling Extensions

Add to `~/.veil/settings.json`:

```json
{
  "disabledExtensions": ["confirm-destructive", "titlebar-spinner"]
}
```

Use the filename without `.ts`.

## Writing Extensions

Extensions export a default function that receives the extension API:

```typescript
import type { ExtensionAPI } from "@engrammic/veil";

export default function myExtension(veil: ExtensionAPI) {
  // Register tools
  veil.registerTool({
    name: "my_tool",
    description: "Does something useful",
    parameters: { /* JSON Schema */ },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: "Done!" }] };
    },
  });

  // Register commands
  veil.registerCommand({
    name: "mycommand",
    description: "My custom command",
    async execute(args, ctx) {
      ctx.ui.notify("Hello!", "info");
    },
  });

  // Subscribe to events
  veil.on("agent_start", async (event, ctx) => {
    // Called when agent starts working
  });

  veil.on("agent_end", async (event, ctx) => {
    // Called when agent finishes
  });

  veil.on("turn_start", async (event, ctx) => {
    // Called before each LLM turn
  });

  veil.on("tool_result", async (event, ctx) => {
    // Called after tool execution
  });
}
```

See `packages/coding-agent/examples/extensions/` for more examples.

## Extension API Reference

### ExtensionAPI

| Method | Description |
|--------|-------------|
| `registerTool(def)` | Register a custom tool |
| `registerCommand(def)` | Register a slash command |
| `on(event, handler)` | Subscribe to lifecycle events |
| `exec(cmd, args)` | Execute shell command |
| `getSessionName()` | Get current session name |

### ExtensionContext (passed to handlers)

| Property | Description |
|----------|-------------|
| `hasUI` | Whether interactive UI is available |
| `ui` | UI methods (notify, confirm, select, setTitle, etc.) |
| `sessionManager` | Access to session entries |
| `cwd` | Current working directory |

### Events

| Event | When |
|-------|------|
| `session_start` | Session initialized |
| `session_shutdown` | Session ending |
| `agent_start` | Agent begins processing |
| `agent_end` | Agent finishes |
| `turn_start` | Before LLM call |
| `turn_end` | After LLM response |
| `tool_result` | After tool execution |
| `session_before_fork` | Before forking (can cancel) |
| `session_before_switch` | Before switching session (can cancel) |
