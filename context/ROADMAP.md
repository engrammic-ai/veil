# Veil Roadmap

High-level roadmap. The near-term architecture detail lives in `context/DESIGN-autonomic.md` (design of record); this file is the canonical sequencing view. Last reconciled against code 2026-06-24.

## Vision

Veil is **autonomic context** for AI agents: context that governs itself, so the user (and the agent) stop thinking about it. Robust, stable, self-governing, intelligent — a tool, not just a prompting harness.

General-purpose: coding is the primary case, but Veil is equally for ralph-wiggum loops and MCP-driven task automation. It improves whatever people do with it, ambiently, through hooks.

---

## Direction: Autonomic (two-speed)

- **Fast path (reflexes):** deterministic scorer + eviction on the hot path — no model, sub-10ms, never blocks. Robust by construction.
- **Slow path (deliberation):** an intelligent layer off the critical path that reads the local event log and writes **policy only** (tuned parameters + a worldview model). Safety invariant: it never mutates live context, only the rules — bad policy is bounded and reversible.
- **Local-first:** everything works on local SQLite alone. No LLM in the memory loop by default. The engrammic KG/cloud is one *optional* cold adapter, never a requirement.

Full detail, rationale, and open questions: `context/DESIGN-autonomic.md`.

---

## Current State (verified against code 2026-06-24)

```
[✓] Fork & Foundation — Pi fork (MIT), packages/engrammic, pnpm workspace
[✓] Warm cache — SQLite (better-sqlite3, WAL), prepared statements
[✓] Harness wiring — VeilHarness integrated into AgentSession hooks
[✓] Capture — auto-capture of tool results into warm cache
[✓] Injection — <veil-context> stubs; anticipatory manifest; failure-section surfacing
[✓] Eviction — 3-stage cascade + adaptive threshold + circuit breaker
[✓] Cognitive weight — afterToolCall -> recordOutcome -> SQL update -> scorer reads it
[~] Cold tier — SqliteColdStore working; KG/engrammic adapter stubbed (throws), optional
[✓] Agent tools — 8 veil_* tools registered with executors
[✓] Self-tuning — AIMD re-request back-off + decay sweep scheduling
[✓] Worldview — tree-sitter parser, symbol extraction, PageRank, co-access, unified anticipation
[✓] Failure-memory — AttemptStore, ConvergenceMonitor, goal inference, attempt surfacing
[✓] Distribution — Bun binaries, Go installer, GCS + GitHub Releases + npm (2026-06-23)
```

---

## Roadmap

### Phase A — Foundation hardening — DONE 2026-06-15
**Goal:** close the wiring gaps the autonomic layer needs.

| Milestone | Description | Status |
|-----------|-------------|--------|
| A.1 Single source of truth | Reconcile docs; fix stale weights line in `docs/veil/architecture.md` | DONE |
| A.2 Register tools | Wire the 8 `veil_*` tools with executors in `main.ts` | DONE |
| A.3 Re-request signal | Durable eviction ledger + cross-check on recall/re-capture | DONE |

### Phase B — Self-tuning controller (MVP) — DONE 2026-06-15
**Goal:** eviction tunes itself from its own mistakes; decay actually runs.
**Plan:** `context/plans/autonomic-mvp-self-tuning.md` (7 TDD tasks, all in packages/engrammic, no LLM).

| Milestone | Description | Status |
|-----------|-------------|--------|
| B.1 Eviction ledger | `{item_id, content_hash, evicted_at, evicted_turn}` in warm cache | DONE |
| B.2 AIMD back-off | Re-request miss raises threshold (evict less) | DONE |
| B.3 Miss detection | cold-fetch + re-capture paths -> back off | DONE |
| B.4 Schedule decay | Run `runDecaySweep` on the turn tick | DONE |

**Deliverable / success test:** re-request rate drops over a session with zero hand-tuning.

**Commits:** `37d00218..a55e5ae0` (10 commits including review fixes)

### Phase C — Worldview foundation — DONE 2026-06-16
**Goal:** Veil learns what matters here, deterministically.

| Milestone | Description | Status |
|-----------|-------------|--------|
| C.1 Tree-sitter mapper | `TreeSitterParser` + `SymbolExtractor` + `graphology` pagerank + `better-sqlite3` cache | DONE |
| C.2 Behavioral worldview | `CoAccessTracker` for co-access patterns from event log | DONE |
| C.3 Structural worldview | `SymbolStore` + `RankStore` + `UnifiedAnticipator` | DONE |
| C.4 Harness wiring | `enableWorldview: true` config creates stores in ContextManager | DONE |

**Commits:** `9b977b92` (C.4 wiring)

### Phase D — Loops & failure-memory (ambient) — DONE 2026-06-16
**Goal:** make any unattended loop converge instead of repeating dead ends.

| Milestone | Description | Status |
|-----------|-------------|--------|
| D.1 Attempt records | `AttemptRecord` + `AttemptStore` for retain-high failure memory | DONE |
| D.2 Surfacing | `formatFailureSection()` injects "Already tried" block | DONE |
| D.3 Convergence monitor | `ConvergenceMonitor` with escalation levels 0-3 | DONE |
| D.4 Goal-boundary cascade | `extractTarget`, `inferGoalId`, `detectRetryMarker`, LLM stub | DONE |

**Commits:** `117a5392` (expanded retry markers)

---

### Phase E — Compression pipeline — DONE 2026-06-16
**Goal:** route content by type through appropriate compressors; non-destructive (originals recoverable).

| Milestone | Description | Status |
|-----------|-------------|--------|
| E.1 Content-type detector | `contentType(chunk)` heuristic: code/prose/config/conversation | DONE |
| E.2 Compression dispatcher | Route chunks to appropriate compressor by type | DONE |
| E.3 JSON/config compressor | Task-relevant key extraction (deterministic) | DONE |
| E.4 Conversation compressor | Head-summary + tail-preserve (deterministic) | DONE |
| E.5 Prose compressor | Slow-path only, model-gated, optional | DEFERRED |
| E.6 Integration | Wire into VeilHarness.autoCapture() | DONE |

**New:** `compression/` module — content-type.ts, dispatcher.ts, config-compress.ts, conversation-compress.ts.
**Existing:** `ast-compress.ts` handles code compression (signature + `[IMPL:hash]`), wrapped by code-compress.ts.

---

### Ship — Distribution — DONE 2026-06-23

**Goal:** one-liner install for users to try Veil.

```bash
curl -sSL https://veil.engrammic.ai/install | sh
```

| Milestone | Description | Status |
|-----------|-------------|--------|
| S.1 Binary builds | `scripts/build-release.sh` — Bun binaries for linux/darwin x64/arm64 | DONE |
| S.2 Install script | `scripts/install.sh` — downloads binary for platform | DONE |
| S.3 GitHub Releases | `release.yml` workflow_dispatch → GH releases + GCS | DONE |
| S.4 Go installer | `installer/` — native Go installer binaries | DONE |
| S.5 npm publish | Automated in release workflow | DONE |
| S.6 README + docs | User-facing quick-start | DONE |

**Distribution flow:**
1. `gh workflow run release.yml` with version input
2. Bun builds binaries, Go builds installer
3. Publishes to GCS + GitHub Releases + npm

---

### Cross-cutting / later

**Validation & tuning** (ongoing): run real sessions, log eviction decisions, track re-request rate, calibrate decay. Target <5% re-request.

**CLI & UX**: `--veil` flag, `/context` command, status bar. (Status-bar / `/context` UX was specced and partially implemented; reconcile and finish.)

**Extension API**: expose `pi.veil.*`, emit `context_eviction` / `context_checkpoint` events, docs + examples.

**Multi-agent (community subagents package)**: fork/merge `VeilHarness` across subagents per `context/SPEC-subagent-context.md`. Replaces the dropped Go orchestrator (archived at `context/archive/go-orchestrator-spec.md`).

**Optional cloud (engrammic)**: KG cold adapter for cross-device/cross-session memory; team/shared workspaces. Opt-in, never required — local SQLite is always sufficient.

**Advanced**: confidence-aware retrieval, embedding-based semantic worldview (optional local model).

---

## Sequencing

```
Done   → Phase A-E (foundation, self-tuning, worldview, failure-memory, compression) → Ship (distribution)
Now    → CLI/UX polish, extension API
Later  → Multi-agent (subagents pkg)
Opt-in → engrammic cloud cold tier, advanced features
```

---

## Dependencies

| Dependency | Required For | Status |
|------------|--------------|--------|
| Pi Agents fork | All | Done |
| SQLite (better-sqlite3) | Warm + cold | Done |
| web-tree-sitter + grammars + graphology | Phase C mapper | Done |
| Community subagents package | Multi-agent | Not started |
| engrammic KG / `@engrammic/sdk` | Optional cloud cold tier | Stubbed, future, optional |

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Eviction too aggressive | User re-requests frequently | Self-tuning back-off (Phase B), pinning |
| Eviction too conservative | Context overflows | Force-evict stage; threshold creep |
| Worldview goes stale | Confidently misleads | Incremental update + mtime/git invalidation (never a snapshot) |
| Model creeps onto hot path | Flakiness returns | Two-speed invariant: slow layer edits policy only; model work is off-path/opt-in |
| Cold-tier coupling to engrammic | Hard dependency on a product | Keep engrammic an optional adapter; local SQLite always works |

---

## Success Metrics

| Metric | Target | Phase |
|--------|--------|-------|
| Re-request rate drops with no hand-tuning | demonstrable downward trend | B |
| Eviction re-request rate | <5% | validation |
| Context overflow incidents | 0 | A–B |
| Worldview staleness after file change | invalidated within the same session | C |
| Loop convergence (escalate vs grind) | no silent infinite grind | D |
| Cold retrieval latency | <500ms | optional cloud |
