// packages/engrammic/src/tools.ts

import type { ContextItem } from "./types.ts";
import { formatStub } from "./injection.ts";
import { hydrateStub, parseStub } from "./hydration.ts";
import type { ContextManager } from "./manager.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: { type: string } }>;
    required: string[];
  };
}

export const TOOL_SCHEMAS: ToolDefinition[] = [
  {
    name: "veil_recall",
    description:
      "Search your memory for relevant past context. Returns matching items as stubs you can hydrate or promote.",
    parameters: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Tags to search for" },
        limit: { type: "number", description: "Maximum number of results (default: 10)" },
      },
      required: ["tags"],
    },
  },
  {
    name: "veil_promote",
    description:
      "Bring an item into your active context so it's visible every turn. Use when you'll reference something repeatedly.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the item to promote" },
      },
      required: ["id"],
    },
  },
  {
    name: "veil_demote",
    description:
      "Remove an item from active context to free up budget. Item stays in memory for later recall.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the item to demote" },
      },
      required: ["id"],
    },
  },
  {
    name: "veil_remember",
    description:
      "Store something important for later. Use for insights, decisions, or facts you'll need again.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to remember" },
        type: {
          type: "string",
          description: "Type of memory",
          enum: ["episodic", "fact", "procedural"],
        },
        tags: { type: "array", items: { type: "string" }, description: "Tags for later retrieval" },
      },
      required: ["content", "type"],
    },
  },
  {
    name: "veil_pin",
    description:
      "Lock an item in active context. Pinned items survive eviction even under budget pressure.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the item to pin" },
      },
      required: ["id"],
    },
  },
  {
    name: "veil_unpin",
    description: "Unlock a pinned item, allowing it to be evicted if needed.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the item to unpin" },
      },
      required: ["id"],
    },
  },
  {
    name: "veil_forget",
    description: "Permanently delete something from all memory tiers. Cannot be undone.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID of the item to forget" },
      },
      required: ["id"],
    },
  },
  {
    name: "veil_hydrate",
    description:
      "Expand a stub to see its full content. Use when you need the details, not just the summary.",
    parameters: {
      type: "object",
      properties: {
        stub: { type: "string", description: 'Stub to hydrate, e.g., "[EPISODE:abc123]"' },
      },
      required: ["stub"],
    },
  },
];
