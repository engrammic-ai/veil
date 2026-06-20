# Veil Roadmap

Veil is a context-aware agent harness forked from [Pi](https://pi.dev). It adds autonomic context management — context that governs itself.

---

## Vision

**Autonomic context for AI agents**: context that governs itself, so users (and agents) stop thinking about it. Robust, stable, self-governing, intelligent.

General-purpose: coding is the primary use case, but Veil works equally well for autonomous loops and MCP-driven task automation.

---

## Architecture: Two-Speed

- **Fast path (reflexes):** deterministic scorer + eviction on the hot path — no model, sub-10ms, never blocks
- **Slow path (deliberation):** intelligent layer off the critical path that writes policy only (tuned parameters + worldview model) — never mutates live context
- **Local-first:** everything works on local SQLite alone; cloud/KG is optional

---

## Current State

| Feature | Status |
|---------|--------|
| Fork & foundation | Done |
| Warm cache (SQLite, WAL) | Done |
| Harness wiring (AgentSession hooks) | Done |
| Auto-capture of tool results | Done |
| Context injection (`<veil-context>` stubs) | Done |
| Heuristic eviction (3-stage cascade) | Done |
| Cognitive weight tracking | Done |
| Self-tuning (AIMD back-off) | Done |
| Worldview (tree-sitter, PageRank, co-access) | Done |
| Failure memory (attempt records, convergence monitor) | Done |
| Compression pipeline (content-type routing) | Done |
| Cold tier (local SQLite) | Done |
| Cold tier (engrammic KG) | Stubbed, optional |

---

## Roadmap

### Shipping

- Binary builds (`bun build --compile` for all platforms)
- Install script (`curl -sSL https://veil.engrammic.ai/install | sh`)
- GitHub Releases automation
- User-facing docs

### CLI & UX

- `--veil` flag for enabling context management
- `/context` command for inspection
- Status bar integration

### Extension API

- Expose `pi.veil.*` namespace
- Emit `context_eviction` / `context_checkpoint` events
- Documentation + examples

### Multi-Agent

- Fork/merge VeilHarness across subagents
- Shared context coordination

### Optional Cloud

- Engrammic KG cold adapter for cross-device/cross-session memory
- Team/shared workspaces
- Always opt-in — local SQLite is sufficient

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Re-request rate | <5% |
| Context overflow incidents | 0 |
| Worldview staleness after file change | Invalidated same session |
| Loop convergence | No silent infinite grind |

---

## Acknowledgments

Veil is built on [Pi](https://pi.dev) by Mario Zechner and contributors. We're grateful for the solid foundation.
