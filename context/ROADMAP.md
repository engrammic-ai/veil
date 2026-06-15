# Veil Roadmap

High-level roadmap. The near-term architecture detail lives in `context/DESIGN-autonomic.md` (design of record); this file is the canonical sequencing view. Last reconciled against code 2026-06-15.

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

## Current State (verified against code 2026-06-15)

```
[✓] Fork & Foundation — Pi fork (MIT), packages/engrammic, pnpm workspace
[✓] Warm cache — SQLite (better-sqlite3, WAL), prepared statements
[✓] Harness wiring — VeilHarness integrated into AgentSession hooks
       (agent-session.ts:413-443, main.ts:700-723) — beforeToolCall/afterToolCall fire
[✓] Capture — auto-capture of tool results into warm cache
[✓] Injection — <veil-context> stubs; anticipatory manifest (Phase 5 path)
[✓] Eviction — 3-stage cascade + adaptive threshold + circuit breaker
[✓] Cognitive weight — afterToolCall -> recordOutcome -> SQL update -> scorer reads it (FULLY WIRED)
[~] Cold tier — SqliteColdStore working; KG/engrammic adapter stubbed (throws), optional
[✓] Agent tools — 8 veil_* tools registered with executors (2026-06-15)
[✓] Self-tuning — AIMD re-request back-off + decay sweep scheduling (2026-06-15)
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

### Phase C — Worldview foundation — NEXT
**Goal:** Veil learns what matters here, deterministically.

| Milestone | Description | Status |
|-----------|-------------|--------|
| C.1 Tree-sitter mapper | web-tree-sitter + Aider `.scm` queries + graphology pagerank + better-sqlite3 cache (build, don't wrap graphify). One parser feeds worldview + AST compression + mtime invalidation | TODO |
| C.2 Behavioral worldview | co-access / re-request / success correlation from the event log (universal, no model) | TODO |
| C.3 Structural worldview | code graph as an optional coding-domain provider behind an interface | TODO |

### Phase D — Loops & failure-memory (ambient)
**Goal:** make any unattended loop converge instead of repeating dead ends.

| Milestone | Description | Status |
|-----------|-------------|--------|
| D.1 Attempt records | retain-high memory of tried-and-failed approaches | TODO |
| D.2 Surfacing | inject a deterministic "already tried, failed" block per attempt | TODO |
| D.3 Convergence monitor | escalate/halt on no-progress (autonomic "only bother the human when needed") | TODO |
| D.4 Goal-boundary cascade | free signals -> mine transcript -> optional cheap-model composer (see DESIGN section 9) | TODO |

---

### Cross-cutting / later

**Validation & tuning** (ongoing): run real sessions, log eviction decisions, track re-request rate, calibrate decay. Target <5% re-request.

**CLI & UX**: `--veil` flag, `/context` command, status bar. (Status-bar / `/context` UX was specced and partially implemented; reconcile and finish.)

**Extension API**: expose `pi.veil.*`, emit `context_eviction` / `context_checkpoint` events, docs + examples.

**Multi-agent (community subagents package)**: fork/merge `VeilHarness` across subagents per `context/SPEC-subagent-context.md`. Replaces the dropped Go orchestrator (archived at `context/archive/go-orchestrator-spec.md`).

**Optional cloud (engrammic)**: KG cold adapter for cross-device/cross-session memory; team/shared workspaces. Opt-in, never required — local SQLite is always sufficient.

**Advanced**: AST-aware compression (shares Phase C's parser), confidence-aware retrieval, embedding-based semantic worldview (optional local model).

---

## Sequencing

```
Now    → Phase A (foundation hardening)
Next   → Phase B (self-tuning controller — MVP)
Then   → Phase C (worldview) → Phase D (loops/failure-memory)
Later  → validation, CLI/UX finish, extension API, multi-agent (subagents pkg)
Opt-in → engrammic cloud cold tier, advanced features
```

---

## Dependencies

| Dependency | Required For | Status |
|------------|--------------|--------|
| Pi Agents fork | All | Done |
| SQLite (better-sqlite3) | Warm + cold | Done |
| web-tree-sitter + grammars + graphology | Phase C mapper | Not started |
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
