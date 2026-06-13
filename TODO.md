# Veil TODO

## Rebrand Status

- [x] Rename CLI: `pi` → `veil`
- [x] Update CLI description and help text
- [x] Rename config dir: `.pi` → `.veil`
- [x] Add Pi → Veil migration (auto-copies ~/.pi to ~/.veil)
- [x] Remove Pi branding — user-facing strings done
- [x] Disable pi.dev endpoints (version check, telemetry, share viewer)
- [ ] Update docs (README done, others TBD)
- [ ] Update GitHub Actions workflows

> Internal packages stay `@earendil-works/pi-*` for upstream compatibility.
> CLI package rename to `@engrammic/veil` only when distributing via npm.

## API Endpoints (engrammic.ai)

> Implement these backend services to replace disabled pi.dev endpoints

- [ ] `GET /api/latest-version` — returns `{ version, packageName?, note? }`
- [ ] `GET /api/report-install` — install telemetry (or decide to skip)
- [ ] Session viewer at `/session/#<gist_id>` — renders shared sessions
- [ ] Changelog page at `/changelog`

---

## Phase 1: Core Context ✅

- [x] Create `packages/engrammic/` — context manager with SQLite warm cache
- [x] Implement heuristic scoring (scorer.ts)
- [x] Implement eviction logic (checkEviction in manager.ts)
- [x] Create VeilHarness with Pi-compatible hooks
- [x] Add sessionId support to VeilHarness

## Phase 2: Cold Storage ✅

- [x] ColdStore interface for pluggable backends
- [x] SqliteColdStore (default, zero config)
- [x] MemoryColdStore (testing)
- [x] Stub adapters: Zep, LanceDB, Chroma, Mem0, Engrammic KG

## Phase 3: Integration ✅

- [x] Wire VeilHarness into agent-session.ts
  - [x] Add VeilHarness as optional AgentSessionConfig field
  - [x] Compose Veil hooks before extension hooks in _installAgentToolHooks
  - [x] Create VeilHarness in main.ts with cleanup handlers
- [ ] Add context lifecycle events to extension system
- [ ] Integrate with compaction (eviction-aware compaction)

## Phase 4: Polish

- [ ] CLI flags for context config (`--context-budget`, `--eviction-threshold`)
- [ ] `/context` command for visibility
- [ ] `/veil` command for memory management
- [ ] Documentation
- [ ] Test harness end-to-end with API key

## Housekeeping

- [ ] Fix pnpm shrinkwrap script (currently needs `--no-verify`)
- [ ] Fix tsgo type errors (Response/Headers types)
- [ ] Update CI workflows for pnpm
