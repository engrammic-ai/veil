# Veil TODO

## BEFORE FIRST PUBLISH - REBRAND

> **DO NOT PUBLISH WITHOUT COMPLETING THIS**

- [ ] Rename all packages: `@earendil-works/pi-*` → `@engrammic/veil-*`
- [ ] Update all internal imports across packages
- [ ] Rename CLI: `pi` → `veil`
- [ ] Update all documentation
- [ ] Update AGENTS.md
- [ ] Remove Pi branding (logos, pi.dev references)
- [ ] Update GitHub Actions workflows

---

## Phase 1: Core Context ✅

- [x] Create `packages/engrammic/` — context manager with SQLite warm cache
- [x] Implement heuristic scoring (scorer.ts)
- [x] Implement eviction logic (checkEviction in manager.ts)
- [x] Create VeilHarness with Pi-compatible hooks

## Phase 2: Cold Storage ✅

- [x] ColdStore interface for pluggable backends
- [x] SqliteColdStore (default, zero config)
- [x] MemoryColdStore (testing)
- [x] Stub adapters: Zep, LanceDB, Chroma, Mem0, Engrammic KG

## Phase 3: Integration (Current)

- [ ] Wire VeilHarness into agent-session.ts
  - Compose Veil hooks before extension hooks
  - Add VeilHarness as optional AgentSessionConfig
- [ ] Add context lifecycle events to extension system
- [ ] Integrate with compaction (eviction-aware compaction)

## Phase 4: Polish

- [ ] CLI flags for context config (`--context-budget`, `--eviction-threshold`)
- [ ] `/context` command for visibility
- [ ] `/veil` command for memory management
- [ ] Documentation

## Housekeeping

- [ ] Fix pnpm shrinkwrap script (currently needs `--no-verify`)
- [ ] Update CI workflows for pnpm
