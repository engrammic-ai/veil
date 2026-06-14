// packages/engrammic/src/tools.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MemoryColdStore } from "./cold/memory.ts";
import { ContextManager } from "./manager.ts";
import { executeVeilTool, TOOL_SCHEMAS } from "./tools.ts";

describe("TOOL_SCHEMAS", () => {
  test("has 8 tools defined", () => {
    expect(TOOL_SCHEMAS).toHaveLength(8);
  });

  test("all tools have veil_ prefix", () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.name.startsWith("veil_")).toBe(true);
    }
  });

  test("array properties have items schema", () => {
    const recallTool = TOOL_SCHEMAS.find((t) => t.name === "veil_recall")!;
    expect(recallTool.parameters.properties.tags.items).toEqual({ type: "string" });
  });
});

describe("executeVeilTool", () => {
  let tmpDir: string;
  let manager: ContextManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tools-test-"));
    manager = new ContextManager(
      { dbPath: join(tmpDir, "context.db") },
      new MemoryColdStore()
    );
  });

  afterEach(async () => {
    await manager.close();
    rmSync(tmpDir, { recursive: true });
  });

  test("veil_remember stores and returns stub", async () => {
    const result = await executeVeilTool(
      "veil_remember",
      { content: "Important fact", type: "fact", tags: ["test"] },
      { manager }
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeTruthy();
    expect((result.data as any).id).toBeTruthy();
    expect((result.data as any).stub).toContain("[FACT:");
  });

  test("veil_recall finds stored items", async () => {
    manager.remember("Test content", "episodic", ["test-tag"]);

    const result = await executeVeilTool("veil_recall", { tags: ["test-tag"] }, { manager });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  test("veil_promote loads item into context", async () => {
    const item = manager.remember("Content to promote", "fact", []);
    const result = await executeVeilTool("veil_promote", { id: item.id }, { manager });

    expect(result.success).toBe(true);
    const window = manager.getWindow();
    expect(window.items).toHaveLength(1);
  });

  test("veil_demote unloads item from context", async () => {
    const item = manager.remember("Content", "fact", []);
    manager.load([item.id]);
    expect(manager.getWindow().items).toHaveLength(1);

    await executeVeilTool("veil_demote", { id: item.id }, { manager });
    expect(manager.getWindow().items).toHaveLength(0);
  });

  test("veil_pin marks item as pinned", async () => {
    const item = manager.remember("Important", "fact", []);
    manager.load([item.id]);

    await executeVeilTool("veil_pin", { id: item.id }, { manager });
    const window = manager.getWindow();
    expect(window.items[0].pinned).toBe(true);
  });

  test("veil_unpin marks item as unpinned", async () => {
    const item = manager.remember("Important", "fact", []);
    manager.load([item.id]);
    manager.pin(item.id);

    await executeVeilTool("veil_unpin", { id: item.id }, { manager });
    const window = manager.getWindow();
    expect(window.items[0].pinned).toBe(false);
  });

  test("veil_forget removes item", async () => {
    const item = manager.remember("To forget", "episodic", []);

    const result = await executeVeilTool("veil_forget", { id: item.id }, { manager });
    expect(result.success).toBe(true);

    const recalled = manager.recall([], 10);
    expect(recalled).toHaveLength(0);
  });

  test("veil_hydrate returns content", async () => {
    const item = manager.remember("Full content here", "fact", []);
    const stub = `[FACT:${item.id}:summary]`;

    const result = await executeVeilTool("veil_hydrate", { stub }, { manager });

    expect(result.success).toBe(true);
    expect((result.data as any).content).toBe("Full content here");
  });

  test("veil_hydrate returns error for invalid stub", async () => {
    const result = await executeVeilTool("veil_hydrate", { stub: "not a stub" }, { manager });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid stub");
  });
});
