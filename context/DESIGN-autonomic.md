# DESIGN: Autonomic Veil

Status: Draft / direction doc — 2026-06-15. Brainstorm output, not yet implementation-ready. Open questions are flagged in section 11.

Related: [[veil-autonomic-direction]] (memory), [[engrammic-identity]] (memory), `alignment/MANIFESTO.md`, `alignment/PRINCIPLES.md`, `context/SPEC-master.md`.

---

## 1. Problem & motivation

Context management is cognitive load that the user (and the agent) should not have to carry. Every coding/agent harness today fails the same way:

- **Claude Code:** auto-compaction destroys in-session context (its summarizer scores ~3.70/5 on retention and compounds loss each cycle); no real cross-session memory; CLAUDE.md ignored past a certain size.
- **Cursor/Windsurf:** "vicious circle" of agent context loss, silent truncation to <half the advertised window, stale codebase index, no persistent memory.
- **Aider/Cline/Continue/OpenHands/Goose/Codex/Gemini CLI:** all reduce to one stale markdown file for "memory" + an LLM summarizer that loops, fails silently, and spikes cost.

The market competes almost entirely on **retrieval** ("what to bring in"). **Eviction** ("what to drop, deterministically") and **self-governing context** are an unoccupied product niche, validated only by 2026 research (CWL `arXiv:2606.11213`; Kumiho `arXiv:2603.17244`).

**Goal:** context that governs itself, so the user stops thinking about it. Four properties, held together: **robust, stable, self-governing, intelligent** — "a tool, not just a prompting harness."

**Scope:** general-purpose. Coding is the primary/ideal case, but Veil is also for ralph-wiggum loops (brute-force `while-not-done: run-agent` grinds) and general MCP-driven task automation. Design must not assume the task is coding.

**Design philosophy — ambient, emergent usage:** Veil improves whatever people do with it by observing through hooks; it does not require users to adopt new APIs or loop primitives. Like Claude Code (built for coding, but people grew loops and automation on top of it), we expect emergent usage and meet it rather than constrain it. "We just make life easier."

---

## 2. Core principle: two-speed (autonomic)

The name for what we are building is **autonomic** — like breathing. Self-running; only escalates to a human when something genuinely needs one.

- **Fast path (reflexes):** the deterministic scorer + eviction. Runs every turn, sub-10ms, no model, never blocks. This is what makes it robust — the hot path physically cannot do anything slow or non-deterministic.
- **Slow path (deliberation):** an intelligent layer that runs off the critical path (between turns / on idle). It reads the local event log and writes **policy only** — the rules the fast path follows next turn.

**Safety invariant (the whole design rests on this):** the slow layer NEVER mutates live context directly. It only edits policy. Worst case is a slightly-off, bounded, reversible policy — never a corrupted context. This is how we get "intelligent" without inheriting everyone else's flakiness.

**No LLM in the memory loop by default.** Three possible sources of intelligence, and where each is allowed:
- (a) No model — counters + arithmetic (control theory, statistics). Default everywhere possible.
- (b) The task LLM via extra calls — basically never; only an explicit manual "deep reflect," never automatic, never inline. (This is exactly what makes competitors flaky and what burns the user's token budget.)
- (c) A small local model (embeddings/MiniLM-class, ~80MB; a tiny classifier) — optional, off-path, only when semantic features are enabled.

**End-to-end flow:** slow layer reads local event log + warm SQLite -> computes derived tables (tuned parameters + worldview) -> writes them to local SQLite -> fast path reads them next turn. A closed local loop; no network, no task-LLM call in the default path.

---

## 3. What the slow layer produces

### 3a. Self-tuning controller (governs the parameters)

Keeps the fast layer calibrated from its own track record. Pure control theory, **zero model** — the lightest spine.

- **Loss signal = re-request:** Veil evicted something, then it was needed again (recalled, re-read, or the user re-asked). That is a measurable mistake.
- **Control law (AIMD, like TCP congestion control):** on a re-request, back off multiplicatively (forget slower, evict less eagerly); when running too full (forced evictions), creep up additively. Clamp to sane bounds.
- **Tunes:** eviction threshold and per-item half-lives first. The five scoring weights stay fixed initially (multi-dimensional, diminishing returns — YAGNI).
- This is mostly the **closure of loops the codebase already half-built**: `runDecaySweep` (defined, never called), the cognitive-weight feedback (in the formula, not wired back), the adaptive threshold (already a crude version of this).
- **The one real prerequisite is plumbing, not ML:** detect "evicted X, then X needed again." The pieces exist (recall events, eviction log, cooldown tracker); they just need to feed a signal.

### 3b. Living worldview (governs what matters)

A continuously-reconciled model of what matters, that knows how current each part of it is. Three flavors, increasing cost:

1. **Behavioral (universal, no model):** co-access, re-request, success correlation, pins — derived from the event log. Works for any domain. **This is the part nobody else has, because nobody else logs the agent's real usage.** It is the universal spine.
2. **Structural (coding-domain plugin, no model):** the code graph (imports, symbols, dependencies) via tree-sitter, PageRanked to the current task. One optional provider behind an interface — see section 5.
3. **Semantic (optional):** embedding similarity, needs the local model from (c).

**Belief-keeping folds in here, locally:** every worldview entry carries **confidence + last-confirmed time**; stale entries decay; contradicted entries are **superseded** by a new version (old kept for history). That is provenance + confidence + supersession done in local SQLite — the same bi-temporal idea a KG uses, with no KG. So the "belief keeper" idea is not a separate spine and does not require engrammic.

**Update / invalidation (the key robustness property — this is where everyone else rots):**
- Incremental + continuous: every capture/access/eviction nudges it. No periodic full rebuild.
- Invalidated on change via file mtime / git diff: when a file changes, only its structural entry recomputes (cheap), and its behavioral importance decays rather than resets (graceful, not a cliff).

---

## 4. Generality & the content-type dispatcher

Because Veil is not coding-only:

- **Behavioral worldview + self-tuning are domain-agnostic** -> the universal spine. A non-code loop simply has no structural provider registered and runs on behavioral signal alone.
- **Capture/compression routes by content type:**

```
contentType(chunk) -> code?         -> AST: signature + [IMPL:hash]   (deterministic)
                   -> prose/docs?   -> summarize / LLMLingua          (model-based, gated)
                   -> config/JSON?  -> task-relevant key extraction   (deterministic)
                   -> conversation? -> head-summary + tail-preserve   (deterministic)
```

- **Two-speed rule applied to compression:** deterministic compressors (AST sig+hash, JSON key-extraction, head/tail) are safe anywhere. Model-based ones (LLMLingua perplexity, recursive summarization) live on the slow path / opt-in only.
- **Why we can afford lossy compression at all: it is non-destructive.** A compressed item is a *view*; the original survives in warm/cold and re-hydrates on demand. The real safety rule is therefore **"never compress something you can't recover"** — which frees us to use even LLMLingua-grade compression on the *cold* tier (latency irrelevant, original recoverable) while keeping hot/warm deterministic.

---

## 5. The code mapper (structural worldview provider)

**Decision: build a thin native layer, do not wrap graphify.** graphify (`safishamsi/graphify`, `graphifyy` on PyPI) is a Python executable, conflates deterministic AST with an LLM doc/semantic pass, and would force a Python runtime + shell-out + on-disk graph parsing. Aider's repo-map is Python-only with no production JS port — but its tree-sitter query files are MIT and reusable.

| Piece | Package | Role |
|---|---|---|
| Parse | `web-tree-sitter` (WASM, no native-compile) + per-language grammars | CST + symbol captures |
| Symbols | Aider's MIT `.scm` query files | def/ref extraction, 26+ langs |
| Rank | `graphology` + pagerank | task-personalized ranking (NetworkX equivalent) |
| Cache | `better-sqlite3`, keyed `path+mtime` | already a dependency |
| TS depth (optional) | `ts-morph` | type-accurate cross-file refs, TS only |

**The lean convergence:** this single tree-sitter layer feeds three things we already want, all on the `better-sqlite3` already shipped:
1. structural worldview (the code graph),
2. AST compression (`signature + [IMPL:hash]`) — same parse, different consumer,
3. worldview invalidation — the `path+mtime` cache key *is* the "recompute changed file, decay the rest" mechanism.

### 5a. Integration decision: anticipatory loading first (DECIDED 2026-06-15)

**Question:** How does structural worldview feed into the system — as a 6th scoring factor (eviction), or for anticipatory loading only?

**Decision:** Start with **anticipatory loading only** (Option B). Structural rank decides *what to preload* when the agent touches a file, not whether to evict it. The scorer stays 5-weight.

**Refinement — structural floor:** Preloaded files receive a temporary minimum score that decays over N turns. This prevents thrash (preload → immediate eviction) without committing to a permanent scoring weight. If the agent touches the file, normal scoring takes over; if not, the floor decays and it evicts naturally.

**Rationale:**
- Clean separation: behavioral worldview is the universal spine, structural is an optional provider
- Lower risk: structural signal could conflict with behavioral; observe first
- Reversible: if structurally-important files evict too early, we add the 6th weight

**Signals to switch to scoring factor (Option A):**
- Preloaded files evicting before use >30% of the time
- Agent re-requesting the same structurally-central files repeatedly
- High-PageRank files consistently in bottom quartile of scores

---

## 6. Local-first & adapters

- **Everything autonomic works on local SQLite alone.** Non-negotiable.
- **engrammic MCP/KG = one optional cold adapter** (cross-device/cross-session sync). Never required; Veil is not a product-sell for it. See [[engrammic-identity]]: the local `@engrammic/veil` harness and the engrammic cloud KG are different things sharing a brand; `EngrammicColdStore` currently throws on every method; cold tier today is SQLite.
- **Multi-agent via the community subagents package** (the Go orchestrator is dropped). Fork/merge `VeilHarness` across subagents per `context/SPEC-subagent-context.md`.

---

## 7. Relationship to existing Veil (verified against code 2026-06-15)

This is not a rewrite; it is finishing what exists. Status verified against the source:

- **Reflexes** = the existing scorer + eviction + adaptive threshold — built and working (`scorer.ts`, `eviction.ts`).
- **The cognitive-weight loop is already fully wired** (correction to an earlier assumption): `afterToolCall -> recordOutcome(success)` (harness.ts:191; manager.ts:275) `-> updateCognitiveWeightBatch` (cache.ts:383, SQL with decay x0.95 + delta +-0.1) `-> scorer.ts:61` reads it into the score. End-to-end. Nothing to fix here.
- **Genuinely open / dead:**
  - `runDecaySweep()` (manager.ts:305) — defined, zero callers. Decay never actually runs.
  - **No re-request signal.** There is ephemeral eviction tracking (`evictedToolCallIds` Set for faded history) and a recall cooldown, but no durable eviction ledger and no path that detects "this item is back because it was evicted." This is the real prerequisite the self-tuning controller needs (see section 11.6).
- **Prerequisites (verified):**
  - **Register the agent tools** — CONFIRMED real. tools.ts defines 9 schemas; `getTools()`/`executeTool()` exist (harness.ts:406-415); but main.ts:700-723 instantiates the harness and never calls `getTools()`, and `customTools` comes only from the CLI flag. The model cannot see `veil_*` tools today.
  - **Single source of truth** — lighter than feared. Code weights (scorer.ts:16-22 = 0.25/0.15/0.30/0.15/0.15) match `eviction-strategy.md` exactly and are canonical; only `architecture.md:75` is stale (0.3/0.2/...). Fix = update architecture.md + cross-link the two doc trees.
- Therefore **"harden the core" and "go autonomic" are largely the same road.**

---

## 8. Robustness properties (why it will not rot)

- Hot path is deterministic -> no flaky summarization, predictable token cost.
- Compression is non-destructive -> originals re-hydrate; "never compress what you can't recover."
- Worldview is continuously reconciled + invalidated on change -> never a stale snapshot (the failure mode of every competitor's index/markdown).
- Slow layer edits only policy -> bad intelligence is bounded and reversible, never a corrupted context.

---

## 9. Failure-memory & loop convergence (ambient)

**Decision: ambient.** Veil watches tool outcomes through the hooks it already has and maintains failure-memory for whatever is looping — a raw `while` script, a ralph-wiggum bash loop, a subagent retry. No `VeilLoop` API is required; an explicit primitive stays optional/later. This follows the emergent-usage philosophy (section 1): make any loop better for free.

**The inversion:** the autonomic layer's default is "didn't help -> fade." Failure-memory inverts it — a tried-and-failed approach is the *most* valuable thing to keep in a loop. So failed attempts are a distinct memory type, retain-high, never eviction candidates while the goal they failed at is still open.

Shape:
- **Attempt record (new memory type):** structured episode — {when/iteration, what was attempted (action + key target, e.g. the file/diff), rationale if available, outcome, evidence (error/test ref)}. Tagged `veil:attempt`, `veil:outcome=fail|pass`. Distinct from ordinary context items.
- **Detection:** mostly free from the existing `afterToolCall` hook — tool error / non-zero exit, test-runner red, error patterns. Repetition and no-progress come from the attempt store itself.
- **Retention inversion:** failed attempts do not decay like normal items and are not eviction candidates while their goal is still open. On overall-goal success they may fade (and optionally demote to cold for cross-session "I tried this last week").
- **Surfacing:** at the start of a new attempt at the same goal, inject a compact, deterministic "Already tried, failed:" block (capped, no LLM — a formatted list of attempt records). Rides the existing anticipatory/injection path (Phase 5) with attempt records as the payload.
- **Convergence / escalation monitor:** track failures-per-iteration and no-progress count. Past a threshold (config; self-tunable later), escalate — surface "stuck, here's what I tried" to the human and/or halt the loop, instead of grinding overnight. This is the autonomic "only bother the human when needed" property applied to loops, and delivers the convergence-detection from `launch/loop-engineering-product.md`.

**Goal-boundary inference (resolved approach; deferred behind the MVP).** Ambient means Veil must infer iteration/goal boundaries from the event stream with no API. This is slow-path *perception*, not a hot-path mutation: a wrong boundary only mis-times the "already-tried" surfacing or mis-counts an iteration — bounded and recoverable, never corrupting context. So an LLM is architecturally *permissible* here (unlike in eviction), provided it stays off the critical path, optional, and only touches surfacing/counters. Build it as a cheapest-first cascade:

1. **Free deterministic signals** — the agent-restart / `turn_start` event (loop iterations usually re-invoke the agent, a strong boundary for free), the same test failing again, repeated tool/file patterns, a new top-level user instruction.
2. **Mine the existing transcript** — parse the agent's own already-emitted text for "that didn't work / trying X" markers. Zero extra inference.
3. **Optional LLM composer (gated, top tier only)** — for genuinely ambiguous cases, a cheap classification call using a small/cheap model (Haiku-class), never the task model, never inline; off by default, rate-limited; its output only moves surfacing/counters.

Not on the MVP critical path (self-tuning needs none of it), so deferred to Phase D. Inline-on-the-task-model is explicitly rejected: cost + latency + the exact coupling we are escaping.

---

## 10. Non-goals (YAGNI)

- No LLM-based eviction or summarization on the hot path.
- No engrammic dependency.
- No Go orchestrator.
- No multi-platform (Cursor/VS Code/etc.) port yet — Pi-first.
- Not coding-only, but also not chasing every domain's structural mapper now — behavioral worldview carries the general case.

---

## 11. Open questions (resolve next)

1. **Iteration / goal-boundary inference (ambient failure-memory)** — RESOLVED as a cheapest-first cascade (see section 9); deferred behind the MVP. Remaining detail: the ambiguity threshold that triggers the optional tier-3 composer. 
2. **MVP slice** — the thinnest first build that proves the autonomic thesis (likely: wire the re-request signal -> self-tuning controller, on top of registering the tools).
3. **Self-tuning control law specifics** — window sizes, clamp bounds, exactly which knobs.
4. **Living-worldview schema** — RESOLVED 2026-06-15. Same SQLite, separate tables. Schema:
   ```sql
   -- Behavioral: co-access patterns
   CREATE TABLE co_access (item_a TEXT, item_b TEXT, count INTEGER, last_turn INTEGER, PRIMARY KEY (item_a, item_b));
   -- Structural: symbol graph from tree-sitter
   CREATE TABLE symbol_graph (file TEXT, symbol TEXT, kind TEXT, target_file TEXT, target_symbol TEXT, PRIMARY KEY (file, symbol, target_file, target_symbol));
   -- Structural: PageRank + task bias
   CREATE TABLE structural_rank (file TEXT PRIMARY KEY, pagerank REAL, task_bias REAL, updated_at INTEGER);
   ```
5. **`contentType(chunk)` detection heuristics** — deterministic dispatch (section 4). Shared with Phase 7 (AST compression) in the existing roadmap.
6. **Re-request signal (the one real prerequisite for self-tuning)** — verified missing today. Needs: (a) a durable eviction ledger `{item_id, evicted_at, eviction_turn}`; (b) `recall`/`fetchFromCold` to cross-check whether a returning item was previously evicted; (c) feed the resulting "miss" events into `eviction.ts` `adjustThreshold`. None exist yet; ephemeral `evictedToolCallIds` + recall cooldown are the only partial pieces.
7. **Tree-sitter mapper build** (section 5 stack: web-tree-sitter + graphology + better-sqlite3) — also lands the Phase 7 AST-compression groundwork (one parser, both consumers).

---

## 12. Recommended sequence

MVP = Phase A + B (smallest thing that visibly "governs itself"; mostly closes loops already half-built).

**Step 0 — Verify prereqs against the code** — DONE 2026-06-15. Cognitive-weight loop was already wired. `runDecaySweep` was dead. No re-request signal existed. Tools were defined but not registered.

**Phase A — Foundation (small, unblocks everything):** — DONE 2026-06-15
1. ~~Single source of truth — reconcile the two doc trees + the contradictory scoring weights.~~ Fixed `docs/veil/architecture.md:75` to match `scorer.ts`.
2. ~~Register the 8 agent tools so the model can drive memory.~~ Wired in `main.ts` with executors routing to `veilHarness.executeTool()`.
3. ~~Wire the re-request signal (the one real prerequisite for self-tuning).~~ Eviction ledger + detection in `remember()` and `fetchFromCold()`.

**Phase B — First autonomic organ (MVP):** — DONE 2026-06-15
4. ~~Self-tuning controller (AIMD on the re-request signal).~~ `recordReRequest()` raises threshold; `runDecaySweep()` now scheduled on tick; ledger pruning added. Commits: `37d00218..a55e5ae0`.

**Phase C — Worldview foundation (triple-payoff brick):** — NEXT

### C.1 Tree-sitter mapper (structural worldview)
5. **Parser setup** — web-tree-sitter WASM + grammar loading for 26 languages. Lazy-load grammars on first file of that type.
6. **Symbol extraction** — Port Aider's MIT .scm query files. Build `symbol_graph` table (defs/refs per file).
7. **Graph ranking** — graphology + PageRank. Populate `structural_rank` table with static ranks.
8. **Task bias** — Personalize ranks to current context (files in hot tier bias the graph).
9. **Cache invalidation** — `path+mtime` keyed. File change → recompute only that file's symbols, decay others' task_bias.
10. **Anticipatory loader** — On file access, query structural_rank for dependency frontier, preload top-N.
11. **Structural floor** — Preloaded files get temporary minimum score (decays over N turns).

### C.2 Behavioral worldview
12. **Co-access tracking** — On each turn, record which items were accessed together → `co_access` table.
13. **Behavioral anticipation** — Co-access patterns feed into anticipatory loading alongside structural rank.

### C.3 Integration
14. **Unified anticipatory loader** — Merge structural + behavioral signals. Weighted blend, configurable.
15. **AST compression consumer** — Hook the parser output for `signature + [IMPL:hash]` compression (Phase 7 groundwork).

**Phase D — Loops / failure-memory:**
7. Attempt records + surfacing + convergence/escalation, with the goal-boundary cascade (section 9).
