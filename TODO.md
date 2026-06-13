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

## Phase 1: Core Context (Current)

- [ ] Create `packages/context/` — context manager
- [ ] Create `packages/memory/` — SQLite warm cache
- [ ] Hook into agent loop (`context` event)
- [ ] Implement heuristic scoring

## Phase 2: Integration

- [ ] Wire context manager into agent-session.ts
- [ ] Replace/extend compaction with eviction
- [ ] Add decay manager

## Phase 3: KG Adapter

- [ ] Interface for cold storage
- [ ] Connect to context-service

## Phase 4: Polish

- [ ] CLI flags for context config
- [ ] `/context` command for visibility
- [ ] Tests
