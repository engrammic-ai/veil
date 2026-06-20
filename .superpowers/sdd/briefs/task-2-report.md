# Task 2 Report: Add Intent Types to veil-memory (Pinned, Never Evicted)

## Status: DONE

## Files Modified

| File | Change |
|------|--------|
| `packages/engrammic/src/types.ts` | Added `"intent"` to `ContextItemType` union |
| `packages/engrammic/src/cache.ts` | Updated SQLite CHECK constraint to include `"intent"` (and `"decision"` which was also missing) |
| `packages/engrammic/src/intent/intent-types.ts` | Added `SessionIntent` interface extending `IntentNode` |
| `packages/engrammic/src/intent/index.ts` | Exported `SessionIntent` |
| `packages/engrammic/src/manager.ts` | Excluded `type === "intent"` from eviction stages 2 and 3 |
| `packages/engrammic/src/fsrs.ts` | Added `intent` to `initialStability` and `stabilityCap` maps (value: 9999 days) |
| `packages/engrammic/src/injection.ts` | Added `intent: "INTENT"` to `TYPE_MAP` |
| `packages/engrammic/src/retrieval.ts` | Added `case "intent": return "Intents"` to `typeHeading` switch |
| `packages/engrammic/src/manager.test.ts` | Added two tests for intent eviction exclusion |

## How Eviction Exclusion Was Implemented

Mirrored exactly how `pinned: true` is handled in `manager.ts`:

- **Stage 2** (soft evict, low-score items): added `|| item.type === "intent"` to the `continue` guard alongside `item.pinned`
- **Stage 3** (force evict, budget exceeded): added `&& i.type !== "intent"` to the `.filter()` alongside `!i.pinned`

Intent items with `initialStability: 9999` also never decay via FSRS, providing a second layer of protection even if eviction logic were somehow bypassed.

## Discovered Issues Fixed

The SQLite schema CHECK constraint only listed `('episodic', 'procedural', 'fact')` — `decision` was already in `ContextItemType` but not in the constraint. Fixed both gaps in one change.

Several `Record<ContextItemType, ...>` maps required exhaustive entries — fixed `fsrs.ts` (two maps), `injection.ts`, and `retrieval.ts`.

## Test Results

- Pre-existing: 25 failing tests in 5 unrelated files (ux, harness, tools, commands/context, harness.integration)
- New intent eviction tests: 2 added, both pass
- Total: 940 passing / 25 failing (same 25 failures as before — no regressions)
- All pre-commit checks passed (biome, ts-imports, shrinkwrap, tsgo type-check)
