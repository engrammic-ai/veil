// packages/engrammic/src/harness.integration.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VeilHarness } from "./harness.ts";

describe("VeilHarness integration", () => {
  let tmpDir: string;
  let harness: VeilHarness;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "harness-integration-"));
    harness = new VeilHarness({ dbPath: join(tmpDir, "context.db") });
  });

  afterEach(async () => {
    await harness.close();
    rmSync(tmpDir, { recursive: true });
  });

  describe("processAutoHydration", () => {
    test("detects and hydrates stubs in output", () => {
      const item = harness.getManager().remember("Full content here", "episodic", []);

      const output = `Looking at [EPISODE:${item.id}:summary], I see something interesting.`;
      const hydrated = harness.processAutoHydration(output);

      expect(hydrated).toContain("<veil-hydrated>");
      expect(hydrated).toContain("Full content here");
      expect(hydrated).toContain("</veil-hydrated>");
    });

    test("returns empty string when no stubs", () => {
      const output = "No stubs in this output.";
      const hydrated = harness.processAutoHydration(output);

      expect(hydrated).toBe("");
    });

    test("hydrates multiple stubs", () => {
      const item1 = harness.getManager().remember("Content one", "fact", []);
      const item2 = harness.getManager().remember("Content two", "procedural", []);

      const output = `See [FACT:${item1.id}:first] and [PROC:${item2.id}:second]`;
      const hydrated = harness.processAutoHydration(output);

      expect(hydrated).toContain("Content one");
      expect(hydrated).toContain("Content two");
    });
  });

  describe("checkpoint triggering", () => {
    test("tick returns true at checkpoint interval", () => {
      const manager = harness.getManager();

      for (let i = 1; i < 10; i++) {
        expect(manager.tick()).toBe(false);
      }
      expect(manager.tick()).toBe(true); // Turn 10

      for (let i = 1; i < 10; i++) {
        expect(manager.tick()).toBe(false);
      }
      expect(manager.tick()).toBe(true); // Turn 20
    });

    test("getTurnCount tracks correctly", () => {
      const manager = harness.getManager();

      expect(manager.getTurnCount()).toBe(0);
      manager.tick();
      expect(manager.getTurnCount()).toBe(1);
      manager.tick();
      manager.tick();
      expect(manager.getTurnCount()).toBe(3);
    });
  });

  describe("getContextSection", () => {
    test("returns empty context message when no items loaded", () => {
      const section = harness.getContextSection();

      expect(section).toContain("<veil-context>");
      expect(section).toContain("No items loaded");
      expect(section).toContain("</veil-context>");
    });

    test("includes loaded items with scores", () => {
      const item = harness.getManager().remember("Test content", "fact", ["test"]);
      harness.getManager().load([item.id]);

      const section = harness.getContextSection();

      expect(section).toContain("[FACT:");
      expect(section).toContain("score:");
      expect(section).toContain("1 items");
    });
  });
});
