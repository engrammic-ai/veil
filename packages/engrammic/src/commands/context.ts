// packages/engrammic/src/commands/context.ts

import type { VeilHarness } from "../harness.ts";
import { estimateTokens } from "../utils.ts";

export interface ContextCommandOutput {
  lines: string[];
}

const typeMap: Record<string, string> = { episodic: "EPISODE", fact: "FACT", procedural: "PROC" };

export function renderContextCommand(harness: VeilHarness): ContextCommandOutput {
  const window = harness.getWindow();
  const stats = harness.getManager().getStats();
  const turnCount = harness.getTurnCount();
  const checkpointInterval = 10; // Could make configurable

  const lines: string[] = [];

  // Header
  lines.push("--- Veil Context ---");
  lines.push("");

  // Hot items
  const hotTokens = window.items.reduce((sum, i) => sum + estimateTokens(i.content), 0);
  lines.push(`HOT (${window.items.length} items, ${formatTokens(hotTokens)})`);

  if (window.items.length === 0) {
    lines.push("  (no items loaded)");
  } else {
    for (const item of window.items) {
      const prefix = typeMap[item.type];
      const summary = item.content.slice(0, 30).replace(/\n/g, " ").trim();
      const tokens = estimateTokens(item.content);
      const pinned = item.pinned ? " [P]" : "";
      lines.push(`  [${prefix}:${item.id.slice(0, 8)}] ${summary}... ${formatTokens(tokens)}${pinned}`);
    }
  }

  lines.push("");

  // Warm stats
  const warmTotal = stats.warm.episodic + stats.warm.fact + stats.warm.procedural;
  lines.push(`WARM: ${warmTotal} items (${stats.warm.episodic} episodic, ${stats.warm.fact} fact, ${stats.warm.procedural} procedural)`);

  // Cold stats
  lines.push(`COLD: ${stats.coldPointers} pointers`);

  lines.push("");

  // Budget
  const budget = window.budget;
  const usedPercent = ((budget.usedTokens / budget.maxTokens) * 100).toFixed(1);
  lines.push(`Budget: ${formatTokens(budget.usedTokens)} / ${formatTokens(budget.maxTokens)} (${usedPercent}% used)`);
  lines.push(`Reserve: ${formatTokens(budget.reserveTokens)}`);

  // Checkpoint
  const nextCheckpoint = (Math.floor(turnCount / checkpointInterval) + 1) * checkpointInterval;
  const turnsUntil = nextCheckpoint - turnCount;
  lines.push(`Next checkpoint: turn ${nextCheckpoint} (in ${turnsUntil} turns)`);

  lines.push("");
  lines.push("--------------------");

  return { lines };
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${n}`;
}
